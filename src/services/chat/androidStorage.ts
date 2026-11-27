import type { AndroidBridge } from '../../app/android.js'
import { readBlobBase64 } from '../../utils/blob.js'
import { mergeSessions } from './history/mergeSessions.js'
import { deleteLegacyHistory, openLegacyHistory } from './indexedDb.js'
import {
  reportStorageError,
  storedSummary,
  type HistoryStaging,
  type StagingWriter,
  type StoredFile,
} from './storageTypes.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

const device = (globalThis as { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid
export const available = Boolean(device?.chatStorage || device?.chatStorageAsync)

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}
type ChatStorageReplyEvent = {
  id: string
  reply: { value?: unknown; error?: string }
}

let requestSeq = 0
const pendingRequests = new Map<string, PendingRequest>()
const ASYNC_TIMEOUT_MS = 60_000
const LEGACY_READ_TIMEOUT_MS = 15_000

if (device?.chatStorageAsync && typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('android-chat-storage', (event: Event) => {
    const detail = (event as CustomEvent<ChatStorageReplyEvent>).detail
    if (!detail?.id) {
      return
    }
    const pending = pendingRequests.get(detail.id)
    if (!pending) {
      return
    }
    pendingRequests.delete(detail.id)
    if (detail.reply?.error) {
      pending.reject(new Error(`${pending.method}: ${detail.reply.error}`))
    } else {
      pending.resolve(detail.reply?.value)
    }
  })
}

const dispatchAsync = <Result>(method: string, call: (id: string) => void): Promise<Result> =>
  new Promise<Result>((resolve, reject) => {
    const id = String(++requestSeq)
    const timer = setTimeout(() => {
      if (!pendingRequests.delete(id)) {
        return
      }
      reject(new Error(`${method}: timed out`))
    }, ASYNC_TIMEOUT_MS)
    pendingRequests.set(id, {
      method,
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as Result)
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    try {
      call(id)
    } catch (error) {
      clearTimeout(timer)
      pendingRequests.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

const request = async <Result = unknown>(method: string, payload: object = {}): Promise<Result> => {
  const json = JSON.stringify(payload)
  const asyncCall = device?.chatStorageAsync
  if (asyncCall) {
    return dispatchAsync<Result>(method, (id) => asyncCall.call(device, id, method, json))
  }
  const reply = device?.chatStorage?.(method, json)
  if (!reply) {
    throw new Error('Android chat storage is unavailable')
  }
  const result = JSON.parse(reply) as { value: Result; error?: string }
  if (result.error) {
    throw new Error(`${method}: ${result.error}`)
  }
  return result.value
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const CHUNK_SIZE = 384 * 1024

const decode = (base64: string) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

type UploadedFile = { id: string; object: string; type: string }
type SerializedSession = { session: Session; data: string }

const write = async ({
  token,
  sessions = [],
  serializedSessions,
  files = [],
  add = false,
  overrideFiles = false,
  blobTimeoutMs,
}: {
  token?: string
  sessions?: Session[]
  serializedSessions?: SerializedSession[]
  files?: StoredFile[]
  add?: boolean
  overrideFiles?: boolean
  blobTimeoutMs?: number
} = {}) => {
  const uploads: UploadedFile[] = []
  try {
    const appendAsync = device?.chatStorageAppendAsync
    for (const { id, blob } of files) {
      const object = await request<string>('upload', { token })
      uploads.push({ id, object, type: blob.type })
      for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
        const data = await readBlobBase64(blob.slice(offset, offset + CHUNK_SIZE), blobTimeoutMs)
        if (appendAsync) {
          await dispatchAsync<null>('append', (requestId) =>
            appendAsync.call(device, requestId, object, data)
          )
        } else {
          await request('append', { object, data })
        }
      }
    }
    const rows: SerializedSession[] =
      serializedSessions ?? sessions.map((session) => ({ session, data: JSON.stringify(session) }))
    const writeSessionAsync = device?.chatStorageWriteSessionAsync
    if (rows.length === 1 && writeSessionAsync) {
      const { session, data } = rows[0]
      const metaJson = JSON.stringify({
        token,
        files: uploads,
        summary: storedSummary(session),
        add,
        overrideFiles,
      })
      await dispatchAsync<null>('write', (id) =>
        writeSessionAsync.call(device, id, metaJson, data)
      )
    } else {
      await request('write', {
        token,
        files: uploads,
        sessions: rows.map(({ session, data }) => ({
          ...storedSummary(session),
          data,
        })),
        add,
        overrideFiles,
      })
    }
  } catch (error) {
    for (const { object } of uploads) {
      try {
        await request('abandon', { object })
      } catch (cleanupError) {
        reportStorageError('abandon attachment upload')(cleanupError)
      }
    }
    throw error
  }
}

const MAX_SESSION_BATCH_COUNT = 32
const MAX_SESSION_BATCH_BYTES = 1024 * 1024
const SINGLE_SESSION_THRESHOLD = 512 * 1024

const writeSessionBatches = async <Item extends SerializedSession>({
  token,
  items,
  add = false,
  pauseBetweenBatches = false,
  onSuccess,
  onError,
}: {
  token?: string
  items: Item[]
  add?: boolean
  pauseBetweenBatches?: boolean
  onSuccess?: (item: Item) => void
  onError?: (item: Item, error: unknown) => void
}) => {
  let batch: Item[] = []
  let batchBytes = 0

  const writeSingle = async (item: Item) => {
    try {
      await write({ token, serializedSessions: [item], add })
      onSuccess?.(item)
    } catch (error) {
      if (!onError) {
        throw error
      }
      onError(item, error)
    }
  }

  const flush = async () => {
    if (!batch.length) {
      return
    }
    const current = batch
    batch = []
    batchBytes = 0
    try {
      await write({ token, serializedSessions: current, add })
      for (const item of current) {
        onSuccess?.(item)
      }
    } catch (batchError) {
      if (current.length === 1) {
        if (!onError) {
          throw batchError
        }
        onError(current[0], batchError)
      } else {
        for (const item of current) {
          await writeSingle(item)
        }
      }
    }
    if (pauseBetweenBatches) {
      await pause()
    }
  }

  for (const item of items) {
    if (item.data.length >= SINGLE_SESSION_THRESHOLD) {
      await flush()
      await writeSingle(item)
      if (pauseBetweenBatches) {
        await pause()
      }
      continue
    }
    if (
      batch.length >= MAX_SESSION_BATCH_COUNT ||
      (batch.length > 0 && batchBytes + item.data.length >= MAX_SESSION_BATCH_BYTES)
    ) {
      await flush()
    }
    batch.push(item)
    batchBytes += item.data.length
  }
  await flush()
}

const readSession = async (id: string, token?: string): Promise<Session | undefined> => {
  const data = await request<string | null>('read', { id, token })
  return data === null ? undefined : (JSON.parse(data) as Session)
}

const readFileTypes = async (ids: Iterable<string>, token: string, includeStaged = false) => {
  const keys = [...new Set(ids)]
  return keys.length
    ? new Map(await request<[string, string][]>('fileTypes', { ids: keys, token, includeStaged }))
    : new Map<string, string>()
}

const pages = async function* <Row>(
  method: 'summaries' | 'ids',
  key: (row: Row) => string,
  token?: string
) {
  let after: string | undefined
  for (;;) {
    const rows = await request<Row[]>(method, { token, after })
    if (!rows.length) {
      return
    }
    yield rows
    after = key(rows[rows.length - 1])
    await pause()
  }
}

const collectSummaries = async () => {
  const summaries: SessionSummary[] = []
  for await (const page of pages('summaries', (summary: SessionSummary) => summary.id)) {
    summaries.push(...page)
  }
  return summaries
}

const mirrorIds = (dir: 'sessions' | 'files'): string[] => {
  const json = device?.shadowList?.(dir)
  if (json == null) {
    throw new Error('Unable to list the legacy Android mirror')
  }
  return JSON.parse(json) as string[]
}

const readMirror = (path: string): Uint8Array<ArrayBuffer>[] => {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    const base64 = device?.shadowReadChunk?.(path, offset)
    if (base64 == null) {
      throw new Error('Unable to read the legacy Android mirror')
    }
    if (!base64) {
      return parts
    }
    const bytes = decode(base64)
    parts.push(bytes)
    offset += bytes.length
  }
}

const sanitizeLegacySession = (id: string, value: unknown): Session | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.messages)) {
    return undefined
  }
  const rawCreated =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined
  const rawUpdated =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined
  const createdAt = rawCreated ?? rawUpdated ?? 0
  const updatedAt = rawUpdated ?? rawCreated ?? 0
  const messages = raw.messages.flatMap((item): Session['messages'] => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const msg = item as Record<string, unknown>
    if (msg.role === 'user') {
      const files = Array.isArray(msg.files)
        ? msg.files.filter(
            (file): file is FileAttachment =>
              Boolean(file) &&
              typeof file === 'object' &&
              typeof (file as { id?: unknown }).id === 'string'
          )
        : []
      return [{ ...(msg as UserMessage), files }]
    }
    if (msg.role === 'assistant') {
      return [msg as AssistantMessage]
    }
    return []
  })
  return {
    ...(raw as Session),
    id: typeof raw.id === 'string' && raw.id ? raw.id : id,
    title: typeof raw.title === 'string' ? raw.title : '',
    createdAt,
    updatedAt,
    messages,
  }
}

const readMirrorSession = (id: string): Session | undefined => {
  const bytes = readMirror(`sessions/${id}.json`)
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const text = bytes.map((part) => decoder.decode(part, { stream: true })).join('')
    const parsed = JSON.parse(text + decoder.decode()) as { id?: unknown } | null
    if (parsed?.id === id) {
      return sanitizeLegacySession(id, parsed)
    }
  } catch {
    // Keep the unreadable source for recovery.
  }
  return undefined
}

export type MigrationNotice = { recovered: number; missing: number; unverified: number }
export type MigrationProgress =
  | { stage: 'reading' }
  | { stage: 'sessions'; done: number; total: number }
  | { stage: 'files'; done: number; total: number }
  | { stage: 'finalizing' }

const emitMigrationProgress = (progress: MigrationProgress | null) => {
  if (typeof globalThis.dispatchEvent === 'function') {
    globalThis.dispatchEvent(
      new CustomEvent('chat-storage-migration-progress', { detail: progress })
    )
  }
}

const withTimeout = <Result>(
  promise: Promise<Result>,
  ms: number,
  message: string
): Promise<Result> => {
  promise.catch(() => {})
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<Result>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  })
}

const isConnectionError = (error: unknown, legacyClosed?: boolean) =>
  Boolean(legacyClosed) ||
  (error instanceof DOMException &&
    (error.name === 'InvalidStateError' || error.name === 'TransactionInactiveError'))

const migrate = async () => {
  let readingShown = false
  const readingTimer = setTimeout(() => {
    readingShown = true
    emitMigrationProgress({ stage: 'reading' })
  }, 300)
  const legacy = await openLegacyHistory().catch((error: unknown) => {
    clearTimeout(readingTimer)
    if (readingShown) {
      emitMigrationProgress(null)
    }
    throw error
  })
  const notice: MigrationNotice = { recovered: 0, missing: 0, unverified: 0 }
  let token: string | undefined
  try {
    const sessionIds = new Set(await legacy?.sessionIds())
    const indexedFiles = new Set(await legacy?.fileIds())
    const indexedIds = new Set([...sessionIds, ...((await legacy?.summaryIds()) ?? [])])
    const mirrorSessions = new Set(mirrorIds('sessions'))
    const mirrorFiles = new Set(mirrorIds('files'))
    clearTimeout(readingTimer)
    const useMirrorList = indexedIds.size === 0
    const ids = useMirrorList ? mirrorSessions : indexedIds
    // An intact legacy index is authoritative for presence. A mirror-only record might
    // be an intentional deletion whose asynchronous mirror write was interrupted.
    if (!useMirrorList) {
      notice.unverified = [...mirrorSessions].filter((id) => !indexedIds.has(id)).length
    }

    token = await request<string>('begin', { migration: true })
    const referenced = new Map<string, string>()
    const writtenIds = new Set<string>()
    let failedFiles = 0
    let migratedSessions = 0
    let sessionsDone = 0
    let lastProgressAt = 0

    const reportSessionProgress = (force = false) => {
      if (!ids.size) {
        return
      }
      const now = performance.now()
      if (force || now - lastProgressAt >= 150) {
        lastProgressAt = now
        emitMigrationProgress({ stage: 'sessions', done: sessionsDone, total: ids.size })
      }
    }

    const recordReferences = (session: Session) => {
      for (const message of session.messages) {
        if (message.role === 'user') {
          for (const file of message.files ?? []) {
            if (!referenced.get(file.id)) {
              referenced.set(file.id, file.mimeType ?? '')
            }
          }
        }
      }
    }

    if (ids.size > 0) {
      reportSessionProgress(true)
    }

    const idList = [...ids]
    const readChunkSize = MAX_SESSION_BATCH_COUNT
    for (let i = 0; i < idList.length; i += readChunkSize) {
      const chunkIds = idList.slice(i, i + readChunkSize)
      const indexedChunk = new Map<string, Session | undefined>()
      const neededIds = chunkIds.filter((id) => sessionIds.has(id))
      if (legacy && neededIds.length > 0) {
        try {
          const rows = await withTimeout(
            legacy.sessions(neededIds),
            LEGACY_READ_TIMEOUT_MS,
            'Timed out reading legacy chat batch'
          )
          neededIds.forEach((id, index) => {
            indexedChunk.set(id, sanitizeLegacySession(id, rows[index]))
          })
        } catch (batchReadError) {
          if (isConnectionError(batchReadError, legacy.isClosed())) {
            throw batchReadError
          }
          for (const id of neededIds) {
            try {
              const row = await withTimeout(
                legacy.session(id),
                LEGACY_READ_TIMEOUT_MS,
                `Timed out reading legacy chat: ${id}`
              )
              indexedChunk.set(id, sanitizeLegacySession(id, row))
            } catch (error) {
              if (isConnectionError(error, legacy.isClosed())) {
                throw error
              }
              reportStorageError('read legacy session')(error)
            }
          }
        }
      }

      const items: (SerializedSession & { recovered: boolean })[] = []
      for (const id of chunkIds) {
        let recovered = false
        let session = indexedChunk.get(id)
        if (!session && mirrorSessions.has(id)) {
          session = readMirrorSession(id)
          recovered = Boolean(session)
        }
        if (!session) {
          notice.missing += 1
          sessionsDone += 1
          continue
        }
        if (writtenIds.has(session.id)) {
          if (!writtenIds.has(id)) {
            session = { ...session, id }
          } else {
            sessionsDone += 1
            continue
          }
        }
        writtenIds.add(session.id)
        items.push({ session, data: JSON.stringify(session), recovered })
      }

      if (items.length > 0) {
        await writeSessionBatches({
          token,
          items,
          add: true,
          pauseBetweenBatches: true,
          onSuccess: (item) => {
            recordReferences(item.session)
            migratedSessions += 1
            sessionsDone += 1
            if (item.recovered) {
              notice.recovered += 1
            }
          },
          onError: (_item, error) => {
            reportStorageError('migrate legacy session')(error)
            notice.missing += 1
            sessionsDone += 1
          },
        })
      }
      reportSessionProgress(i + readChunkSize >= idList.length)
      await pause()
    }

    if (ids.size > 0 && migratedSessions === 0) {
      throw new Error('Unable to read any legacy chats during migration')
    }

    const mirrorOnlyFiles = [...mirrorFiles].filter(
      (id) => !indexedFiles.has(id) && (useMirrorList || referenced.has(id))
    )
    const totalFiles = indexedFiles.size + mirrorOnlyFiles.length
    let filesDone = 0
    const MAX_FILE_BATCH_COUNT = 16
    const MAX_FILE_BATCH_BYTES = 4 * 1024 * 1024
    let fileBatch: { file: StoredFile; fromMirror: boolean }[] = []
    let fileBatchBytes = 0

    const reportFileProgress = (force = false) => {
      if (!totalFiles) {
        return
      }
      const now = performance.now()
      if (force || now - lastProgressAt >= 150) {
        lastProgressAt = now
        emitMigrationProgress({ stage: 'files', done: filesDone, total: totalFiles })
      }
    }

    const writeSingleFile = async (item: StoredFile, fromMirror: boolean) => {
      try {
        await write({ token, files: [item], blobTimeoutMs: LEGACY_READ_TIMEOUT_MS })
      } catch (error) {
        if (!fromMirror && mirrorFiles.has(item.id)) {
          try {
            const blob = new Blob(readMirror(`files/${item.id}.bin`), {
              type: item.blob.type || referenced.get(item.id) || '',
            })
            await write({
              token,
              files: [{ id: item.id, blob }],
              blobTimeoutMs: LEGACY_READ_TIMEOUT_MS,
            })
            return
          } catch (mirrorError) {
            reportStorageError('migrate legacy attachment from mirror')(mirrorError)
          }
        }
        reportStorageError('migrate legacy attachment')(error)
        failedFiles += 1
      }
    }

    const flushFiles = async () => {
      if (!fileBatch.length) {
        return
      }
      const current = fileBatch
      fileBatch = []
      fileBatchBytes = 0
      try {
        await write({
          token,
          files: current.map((entry) => entry.file),
          blobTimeoutMs: LEGACY_READ_TIMEOUT_MS,
        })
      } catch (batchError) {
        if (current.length === 1) {
          await writeSingleFile(current[0].file, current[0].fromMirror)
        } else {
          reportStorageError('migrate legacy attachment batch')(batchError)
          for (const entry of current) {
            await writeSingleFile(entry.file, entry.fromMirror)
          }
        }
      }
      filesDone += current.length
      reportFileProgress(filesDone >= totalFiles)
      await pause()
    }

    const enqueueFile = async (file: StoredFile, fromMirror: boolean) => {
      if (file.blob.size >= MAX_FILE_BATCH_BYTES) {
        await flushFiles()
        await writeSingleFile(file, fromMirror)
        filesDone += 1
        reportFileProgress(filesDone >= totalFiles)
        await pause()
        return
      }
      if (
        fileBatch.length >= MAX_FILE_BATCH_COUNT ||
        (fileBatch.length > 0 && fileBatchBytes + file.blob.size >= MAX_FILE_BATCH_BYTES)
      ) {
        await flushFiles()
      }
      fileBatch.push({ file, fromMirror })
      fileBatchBytes += file.blob.size
    }

    if (totalFiles > 0) {
      reportFileProgress(true)
    }

    for (const id of indexedFiles) {
      let file: StoredFile | undefined
      let fromMirror = false
      if (legacy) {
        try {
          const original = await withTimeout(
            legacy.file(id),
            LEGACY_READ_TIMEOUT_MS,
            `Timed out reading legacy attachment: ${id}`
          )
          if (original?.blob && typeof original.blob.size === 'number') {
            file = original
          }
        } catch (error) {
          if (isConnectionError(error, legacy.isClosed())) {
            throw error
          }
          reportStorageError('read legacy attachment')(error)
        }
      }
      if (!file && mirrorFiles.has(id)) {
        const blob = new Blob(readMirror(`files/${id}.bin`), { type: referenced.get(id) ?? '' })
        file = { id, blob }
        fromMirror = true
      }
      if (!file) {
        failedFiles += 1
        filesDone += 1
        reportFileProgress()
        continue
      }
      await enqueueFile(file, fromMirror)
    }
    for (const id of mirrorOnlyFiles) {
      try {
        const blob = new Blob(readMirror(`files/${id}.bin`), { type: referenced.get(id) ?? '' })
        await enqueueFile({ id, blob }, true)
      } catch (error) {
        reportStorageError('migrate mirror attachment')(error)
        failedFiles += 1
        filesDone += 1
        reportFileProgress()
      }
    }
    await flushFiles()

    if (ids.size > 0 || totalFiles > 0) {
      emitMigrationProgress({ stage: 'finalizing' })
    }
    // This SQLite transaction publishes both stores and the one-time migration marker.
    const retainLegacy = notice.missing > 0 || notice.unverified > 0 || failedFiles > 0
    await request('replace', { token, retainLegacy })
  } catch (error) {
    if (token) {
      try {
        await request('discard', { token })
      } catch (discardError) {
        reportStorageError('discard unfinished migration')(discardError)
      }
    }
    throw error
  } finally {
    clearTimeout(readingTimer)
    emitMigrationProgress(null)
    legacy?.close()
  }
  if (notice.recovered || notice.missing || notice.unverified) {
    globalThis.dispatchEvent(new CustomEvent('chat-storage-migrated', { detail: notice }))
  }
}

let retireTask: Promise<void> | undefined

const retireLegacy = () => {
  if (retireTask) {
    return retireTask
  }
  retireTask = (async () => {
    try {
      if (await request<boolean>('canRetire')) {
        await pause()
        await deleteLegacyHistory()
        if (!device?.shadowClearAll?.()) {
          throw new Error('Unable to remove the legacy Android mirror')
        }
        await request('retired')
      }
    } catch (error) {
      reportStorageError('retire migrated history')(error)
    } finally {
      retireTask = undefined
    }
  })()
  return retireTask
}

const scheduleRetireLegacy = () => {
  if (!retireTask) {
    setTimeout(() => {
      void retireLegacy()
    }, 0)
  }
}

let initialized = false
const initialize = async () => {
  if (initialized) {
    return
  }
  if (await request<boolean>('needsMigration')) {
    await migrate()
  }
  initialized = true
  scheduleRetireLegacy()
}

// File uploads yield while reading blobs. Keep write ordering across those yields,
// including when a rename or delete follows a save still uploading an attachment.
let queue: Promise<unknown> = Promise.resolve()
const run = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
  const result = queue.then(async () => {
    await initialize()
    return operation()
  })
  queue = result.catch(() => {})
  return result
}

export const loadSessionSummaries = () => run(collectSummaries)
export const loadSession = (id: string) => run(() => readSession(id))
export const saveSession = (session: Session, files?: StoredFile[]) =>
  run(() => write({ sessions: [session], files }))
export const renameSession = (id: string, title: string) =>
  run(async () => {
    const session = await readSession(id)
    if (session) {
      await write({ sessions: [{ ...session, title }] })
    }
  })
export const deleteSession = (id: string) =>
  run(async () => {
    await request('remove', { id })
  })

export const scanSessions = (
  onSession: (session: Session) => boolean,
  skip?: ReadonlySet<string>
) =>
  run(async () => {
    for await (const ids of pages('ids', (id: string) => id)) {
      for (const id of ids) {
        if (!skip?.has(id)) {
          const session = await readSession(id)
          if (session && !onSession(session)) {
            return
          }
        }
      }
    }
  })

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const file = await run(async () => {
    const metadata = await request<{ object: string; type: string } | null>('file', { id })
    if (!metadata) {
      return undefined
    }
    const response = await fetch(`/chat-attachment/${metadata.object}`, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error('An Android chat attachment is unreadable')
    }
    return { type: metadata.type, response }
  })
  if (file) {
    const blob = await file.response.blob()
    return blob.slice(0, blob.size, file.type)
  }
  return undefined
}

const applyFileTypes = (session: Session, types: ReadonlyMap<string, string>) => {
  let changed = false
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        const type = types.get(file.id) ?? ''
        if (file.mimeType !== type) {
          file.mimeType = type
          changed = true
        }
      }
    }
  }
  return changed
}

const readStaged = async (id: string, token: string) => {
  const session = await readSession(id, token)
  if (!session) {
    throw new Error(`Staged session disappeared: ${id}`)
  }
  return session
}

export const stagingWriter = (token: string): StagingWriter => {
  const summaries: SessionSummary[] = []
  return {
    summaries,
    getActiveFileTypes: (ids) => run(() => readFileTypes(ids, token)),
    async addSessions(sessions) {
      await run(() =>
        writeSessionBatches({
          token,
          items: sessions.map((session) => ({ session, data: JSON.stringify(session) })),
          add: true,
        })
      )
      for (const session of sessions) {
        summaries.push(toSessionSummary(session))
      }
    },
    addFiles: (files) => run(() => write({ token, files })),
    updateFileTypes: (ids, types) =>
      run(async () => {
        for (const id of ids) {
          const session = await readStaged(id, token)
          if (applyFileTypes(session, types)) {
            await write({ token, sessions: [session] })
          }
        }
      }),
  }
}

export const beginStaging = async (): Promise<HistoryStaging> => {
  const token = await run(() => request<string>('begin'))
  return {
    importId: token,
    commit: () =>
      run(async () => {
        await request('replace', { token })
        scheduleRetireLegacy()
      }),
    discard: () =>
      run(async () => {
        await request('discard', { token })
      }),
    commitMerge: ({ localOverrides } = {}) =>
      run(async () => {
        const revision = await request<string>('revision', { token })
        const summaries = new Map((await collectSummaries()).map((item) => [item.id, item]))
        const stagedIds: string[] = []
        for await (const ids of pages('ids', (id: string) => id, token)) {
          stagedIds.push(...ids)
        }
        const overrideFiles = stagedIds.flatMap((id) => localOverrides?.get(id)?.files ?? [])
        for (let i = 0; i < overrideFiles.length; i += 8) {
          await write({ token, files: overrideFiles.slice(i, i + 8), overrideFiles: true })
        }
        let added = 0
        let merged = 0
        let unchanged = 0
        const updatedIds: string[] = []
        for (let i = 0; i < stagedIds.length; i += 64) {
          for (const id of stagedIds.slice(i, i + 64)) {
            const incoming = await readStaged(id, token)
            const override = localOverrides?.get(id)
            const local =
              override?.session ?? (summaries.has(id) ? await readSession(id) : undefined)
            const fileIds = [
              ...storedSummary(incoming).fileIds,
              ...(local ? storedSummary(local).fileIds : []),
            ]
            const fileTypes = await readFileTypes(fileIds, token, true)
            if (!local) {
              let changed = false
              for (const message of incoming.messages) {
                if (message.role === 'user') {
                  for (const file of message.files) {
                    const type = fileTypes.get(file.id)
                    if (!file.mimeType && type) {
                      file.mimeType = type
                      changed = true
                    }
                  }
                }
              }
              if (changed) {
                await write({ token, sessions: [incoming] })
              }
              summaries.set(id, toSessionSummary(incoming))
              added += 1
              continue
            }
            const result = mergeSessions(local, incoming, { fileTypes })
            if (result.changed || override) {
              await write({ token, sessions: [result.session] })
              summaries.set(id, toSessionSummary(result.session))
              updatedIds.push(id)
            } else {
              await request('remove', { token, id })
            }
            if (result.changed) {
              merged += 1
            } else {
              unchanged += 1
            }
          }
          await pause()
        }
        await request('merge', { token, revision })
        return { summaries: [...summaries.values()], added, merged, unchanged, updatedIds }
      }),
  }
}
