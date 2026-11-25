import type { NativeHttpResponse } from '../../app/android.js'
import type { HttpTransport } from '../search/http.js'
import { conflictArchivePath } from './archive.js'
import type { DeletedMemoryPath, MemoryNote } from './types.js'
import { normalizeMemoryPath } from './store.js'

export type GithubMemoryConfig = {
  repo: string
  branch: string
  token: string
}

export type RemoteMemoryNote = {
  path: string
  content: string
  sha: string
}

export type RemoteMemoryState = {
  headSha: string | null
  notes: RemoteMemoryNote[]
}

export type MemorySyncPlan = {
  pulls: RemoteMemoryNote[]
  pushes: MemoryNote[]
  remoteDeletes: DeletedMemoryPath[]
  conflicts: { path: string; remoteContent: string; localPath?: string }[]
  unchanged: number
}

export class GithubBranchMovedError extends Error {
  constructor() {
    super('GitHub branch moved during sync')
    this.name = 'GithubBranchMovedError'
  }
}

export const parseGithubRepo = (value: string): { owner: string; repo: string } | null => {
  const trimmed = value.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '')
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.length !== 2) {
    return null
  }
  const [owner, repo] = parts
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return null
  }
  return { owner, repo }
}

export const encodeBase64Utf8 = (text: string): string => {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export const decodeBase64Utf8 = (base64: string): string => {
  const binary = atob(base64.replace(/\s+/g, ''))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const apiHeaders = (token: string) => ({
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28',
})

const encodeBranchPath = (branch: string) => branch.split('/').map(encodeURIComponent).join('/')

const apiUrl = ({ repo }: GithubMemoryConfig, suffix: string) => {
  const parsed = parseGithubRepo(repo)
  if (!parsed) {
    throw new Error('仓库格式应为 owner/repository')
  }
  return `https://api.github.com/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}${suffix}`
}

type GithubJson = Record<string, unknown> | unknown[]

const requestJson = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  suffix: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<{ status: number; json: GithubJson; response: NativeHttpResponse }> => {
  if (!config.token.trim()) {
    throw new Error('请先填写访问令牌')
  }
  const response = await transport(
    {
      url: apiUrl(config, suffix),
      method,
      headers: {
        ...apiHeaders(config.token.trim()),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      timeoutMs: 30_000,
    },
    signal
  )
  let json: GithubJson = {}
  try {
    json = response.text ? (JSON.parse(response.text) as GithubJson) : {}
  } catch {
    json = {}
  }
  if (!response.ok) {
    const message =
      !Array.isArray(json) && typeof json.message === 'string'
        ? json.message
        : response.error || `GitHub 请求失败（${response.status}）`
    const error = new Error(message) as Error & { status?: number }
    error.status = response.status
    throw error
  }
  return { status: response.status, json, response }
}

export const testGithubConnection = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  signal?: AbortSignal
): Promise<string> => {
  const { json } = await requestJson(transport, config, 'GET', '', undefined, signal)
  if (!Array.isArray(json) && typeof json.full_name === 'string') {
    return json.full_name
  }
  return config.repo.trim()
}

const readBranchHead = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  signal?: AbortSignal
): Promise<string | null> => {
  const branch = encodeBranchPath(config.branch.trim() || 'main')
  try {
    const { json } = await requestJson(
      transport,
      config,
      'GET',
      `/branches/${branch}`,
      undefined,
      signal
    )
    if (!Array.isArray(json) && json.commit && typeof json.commit === 'object') {
      const commit = json.commit as Record<string, unknown>
      return typeof commit.sha === 'string' ? commit.sha : null
    }
    return null
  } catch (error) {
    if ((error as { status?: number }).status === 404) {
      return null
    }
    throw error
  }
}

export const fetchRemoteMemoryState = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  signal?: AbortSignal
): Promise<RemoteMemoryState> => {
  const headSha = await readBranchHead(transport, config, signal)
  if (!headSha) {
    return { headSha: null, notes: [] }
  }
  const { json: treeJson } = await requestJson(
    transport,
    config,
    'GET',
    `/git/trees/${encodeURIComponent(headSha)}?recursive=1`,
    undefined,
    signal
  )
  const tree = !Array.isArray(treeJson) && Array.isArray(treeJson.tree) ? treeJson.tree : []
  const entries = tree
    .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>) : null))
    .filter(
      (item): item is Record<string, unknown> =>
        item !== null &&
        item.type === 'blob' &&
        typeof item.path === 'string' &&
        typeof item.sha === 'string' &&
        /\.md$/i.test(item.path) &&
        normalizeMemoryPath(item.path) !== null
    )
    .slice(0, 500)
  const notes: RemoteMemoryNote[] = []
  for (const entry of entries) {
    const path = normalizeMemoryPath(String(entry.path))
    if (!path) {
      continue
    }
    const { json: blob } = await requestJson(
      transport,
      config,
      'GET',
      `/git/blobs/${encodeURIComponent(String(entry.sha))}`,
      undefined,
      signal
    )
    if (!Array.isArray(blob) && typeof blob.content === 'string') {
      notes.push({ path, content: decodeBase64Utf8(blob.content), sha: String(entry.sha) })
    }
  }
  return { headSha, notes }
}

export const planMemorySynchronization = ({
  localNotes,
  remoteNotes,
  deletedPaths = [],
  now = Date.now(),
}: {
  localNotes: readonly MemoryNote[]
  remoteNotes: readonly RemoteMemoryNote[]
  deletedPaths?: readonly DeletedMemoryPath[]
  now?: number
}): MemorySyncPlan => {
  const local = new Map(localNotes.map((note) => [note.path, note]))
  const remote = new Map(remoteNotes.map((note) => [note.path, note]))
  const tombstones = new Map(deletedPaths.map((item) => [item.path, item]))
  const paths = new Set([...local.keys(), ...remote.keys()])
  const pulls: RemoteMemoryNote[] = []
  const pushes: MemoryNote[] = []
  const remoteDeletes: DeletedMemoryPath[] = []
  const conflicts: MemorySyncPlan['conflicts'] = []
  let unchanged = 0

  for (const path of paths) {
    const localNote = local.get(path)
    const remoteNote = remote.get(path)
    if (localNote && remoteNote) {
      if (localNote.content === remoteNote.content) {
        unchanged += 1
        continue
      }
      const base = localNote.baseContent
      const localChanged = base === undefined ? true : localNote.content !== base
      const remoteChanged = base === undefined ? true : remoteNote.content !== base
      if (localChanged && remoteChanged) {
        conflicts.push({
          path: conflictArchivePath(path, now),
          remoteContent: remoteNote.content,
          localPath: path,
        })
      } else if (remoteChanged) {
        pulls.push(remoteNote)
      } else if (localChanged) {
        pushes.push(localNote)
      } else {
        unchanged += 1
      }
      continue
    }
    if (localNote && !remoteNote) {
      const base = localNote.baseContent
      if (base !== undefined && localNote.content === base) {
        conflicts.push({
          path: conflictArchivePath(path, now),
          remoteContent: '',
          localPath: path,
        })
      } else {
        pushes.push(localNote)
      }
      continue
    }
    if (!localNote && remoteNote) {
      const tombstone = tombstones.get(path)
      if (tombstone) {
        if (!tombstone.remoteSha || tombstone.remoteSha === remoteNote.sha) {
          remoteDeletes.push(tombstone)
        } else {
          conflicts.push({ path: conflictArchivePath(path, now), remoteContent: remoteNote.content })
        }
      } else {
        pulls.push(remoteNote)
      }
    }
  }
  return { pulls, pushes, remoteDeletes, conflicts, unchanged }
}

type TreeEntry = {
  path: string
  mode: '100644'
  type: 'blob'
  sha: string | null
}

const createMemoryCommit = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  headSha: string | null,
  pushes: readonly MemoryNote[],
  remoteDeletes: readonly DeletedMemoryPath[],
  signal?: AbortSignal
): Promise<{ commitSha: string; blobShas: Record<string, string> }> => {
  const blobShas: Record<string, string> = {}
  const treeEntries: TreeEntry[] = []
  for (const note of pushes) {
    const { json } = await requestJson(
      transport,
      config,
      'POST',
      '/git/blobs',
      { content: encodeBase64Utf8(note.content), encoding: 'base64' },
      signal
    )
    if (Array.isArray(json) || typeof json.sha !== 'string') {
      throw new Error('GitHub 返回了无法识别的文件内容')
    }
    blobShas[note.path] = json.sha
    treeEntries.push({ path: note.path, mode: '100644', type: 'blob', sha: json.sha })
  }
  for (const item of remoteDeletes) {
    treeEntries.push({ path: item.path, mode: '100644', type: 'blob', sha: null })
  }
  if (treeEntries.length === 0) {
    throw new Error('没有需要上传的变更')
  }
  const treeBody: Record<string, unknown> = { tree: treeEntries }
  if (headSha) {
    treeBody.base_tree = headSha
  }
  const { json: treeJson } = await requestJson(
    transport,
    config,
    'POST',
    '/git/trees',
    treeBody,
    signal
  )
  if (Array.isArray(treeJson) || typeof treeJson.sha !== 'string') {
    throw new Error('GitHub 返回了无法识别的目录快照')
  }
  const { json: commitJson } = await requestJson(
    transport,
    config,
    'POST',
    '/git/commits',
    {
      message: 'Update Elsewhere chat memory',
      tree: treeJson.sha,
      parents: headSha ? [headSha] : [],
    },
    signal
  )
  if (Array.isArray(commitJson) || typeof commitJson.sha !== 'string') {
    throw new Error('GitHub 返回了无法识别的提交')
  }
  const branch = config.branch.trim() || 'main'
  if (headSha) {
    try {
      await requestJson(
        transport,
        config,
        'PATCH',
        `/git/refs/heads/${encodeBranchPath(branch)}`,
        { sha: commitJson.sha, force: false },
        signal
      )
    } catch (error) {
      const status = (error as { status?: number }).status
      if (status === 409 || status === 422) {
        throw new GithubBranchMovedError()
      }
      throw error
    }
  } else {
    await requestJson(
      transport,
      config,
      'POST',
      '/git/refs',
      { ref: `refs/heads/${branch}`, sha: commitJson.sha },
      signal
    )
  }
  return { commitSha: commitJson.sha, blobShas }
}

export const pushMemoryChanges = async (
  transport: HttpTransport,
  config: GithubMemoryConfig,
  headSha: string | null,
  pushes: readonly MemoryNote[],
  remoteDeletes: readonly DeletedMemoryPath[],
  originalRemoteNotes: readonly RemoteMemoryNote[],
  signal?: AbortSignal
): Promise<{ commitSha: string; blobShas: Record<string, string>; retried: boolean }> => {
  try {
    const result = await createMemoryCommit(
      transport,
      config,
      headSha,
      pushes,
      remoteDeletes,
      signal
    )
    return { ...result, retried: false }
  } catch (error) {
    if (!(error instanceof GithubBranchMovedError) || !headSha) {
      throw error
    }
    const freshHead = await readBranchHead(transport, config, signal)
    const freshRemote = await fetchRemoteMemoryState(transport, config, signal)
    const originalByPath = new Map(originalRemoteNotes.map((note) => [note.path, note.content]))
    const freshByPath = new Map(freshRemote.notes.map((note) => [note.path, note.content]))
    const touchedPaths = new Set([...pushes.map((note) => note.path), ...remoteDeletes.map((item) => item.path)])
    for (const path of touchedPaths) {
      if (freshByPath.get(path) !== originalByPath.get(path)) {
        throw new Error('同步期间远端有新变更，请重新同步')
      }
    }
    const result = await createMemoryCommit(
      transport,
      config,
      freshHead,
      pushes,
      remoteDeletes,
      signal
    )
    return { ...result, retried: true }
  }
}

export const runMemoryGithubSync = async ({
  transport,
  signal,
}: {
  transport: HttpTransport
  signal?: AbortSignal
}): Promise<import('./types.js').MemorySyncResult> => {
  const {
    clearPushedMemoryTombstones,
    initMemoryStore,
    sortedMemoryNotes,
    updateMemoryConfig,
    upsertMemoryNote,
    useMemoryStore,
  } = await import('./store.js')
  await initMemoryStore()
  const memoryState = useMemoryStore.getState()
  const repo = memoryState.config.githubRepo.trim()
  const branch = memoryState.config.githubBranch.trim() || 'main'
  const { getMemorySecret } = await import('./store.js')
  const token = getMemorySecret()
  const parsed = parseGithubRepo(repo)
  if (!parsed) {
    throw new Error('仓库格式应为 owner/repository')
  }
  if (!token) {
    throw new Error('请先填写访问令牌')
  }
  const githubConfig: GithubMemoryConfig = { repo, branch, token }
  const remote = await fetchRemoteMemoryState(transport, githubConfig, signal)
  const localNotes = sortedMemoryNotes()
  const plan = planMemorySynchronization({
    localNotes,
    remoteNotes: remote.notes,
    deletedPaths: memoryState.deletedPaths,
  })

  const remoteByPathForBaseline = new Map(remote.notes.map((note) => [note.path, note]))
  for (const localNote of localNotes) {
    const remoteNote = remoteByPathForBaseline.get(localNote.path)
    if (
      remoteNote &&
      remoteNote.content === localNote.content &&
      (localNote.remoteSha !== remoteNote.sha || localNote.baseContent !== remoteNote.content)
    ) {
      await upsertMemoryNote({
        ...localNote,
        remoteSha: remoteNote.sha,
        baseContent: remoteNote.content,
      })
    }
  }

  let pulled = 0
  for (const note of plan.pulls) {
    await upsertMemoryNote({
      path: note.path,
      content: note.content,
      updatedAt: Date.now(),
      remoteSha: note.sha,
      baseContent: note.content,
    })
    pulled += 1
  }
  for (const conflict of plan.conflicts) {
    if (conflict.remoteContent) {
      await upsertMemoryNote({
        path: conflict.path,
        content: conflict.remoteContent,
        updatedAt: Date.now(),
      })
    }
  }

  let pushed = 0
  let commitSha: string | undefined
  if (plan.pushes.length > 0 || plan.remoteDeletes.length > 0) {
    const result = await pushMemoryChanges(
      transport,
      githubConfig,
      remote.headSha,
      plan.pushes,
      plan.remoteDeletes,
      remote.notes,
      signal
    )
    commitSha = result.commitSha
    for (const note of plan.pushes) {
      const blobSha = result.blobShas[note.path]
      await upsertMemoryNote({
        ...note,
        updatedAt: Date.now(),
        ...(blobSha ? { remoteSha: blobSha } : {}),
        baseContent: note.content,
      })
    }
    pushed = plan.pushes.length + plan.remoteDeletes.length
    if (plan.remoteDeletes.length > 0) {
      await clearPushedMemoryTombstones(plan.remoteDeletes.map((item) => item.path))
    }
  }

  const conflictPaths = plan.conflicts.map((item) => item.path)
  const status = conflictPaths.length > 0 ? 'conflict' : 'synced'
  updateMemoryConfig({
    lastSyncedAt: Date.now(),
    lastSyncCommitSha: commitSha ?? memoryState.config.lastSyncCommitSha,
    lastSyncStatus: status,
    lastSyncError: undefined,
  })
  return {
    status,
    pushed,
    pulled,
    conflicts: conflictPaths,
    ...(commitSha ? { commitSha } : {}),
  }
}
