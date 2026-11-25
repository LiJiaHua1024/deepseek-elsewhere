import { create } from 'zustand'
import { android } from '../../app/android.js'
import type {
  DeletedMemoryPath,
  MemoryConfig,
  MemoryDreamRun,
  MemoryNote,
} from './types.js'
import {
  clearMemoryNotes,
  deleteMemoryNote,
  getDeletedMemoryPaths,
  getDreamedSessions,
  getLastDreamApplied,
  listMemoryNotes,
  putMemoryNote,
  putMemoryNotes,
  setDeletedMemoryPaths,
  setDreamedSessions,
  setLastDreamApplied,
} from './db.js'

export const MEMORY_CONFIG_STORAGE_KEY = 'elsewhere:memory-config-v1'
export const MEMORY_SECRET_STORAGE_KEY = 'elsewhere:memory-sync-secret-v1'

const DEFAULT_CONFIG: MemoryConfig = {
  enabled: false,
  syncMode: 'local',
  githubRepo: '',
  githubBranch: 'main',
  lastSyncedAt: null,
  lastSyncCommitSha: null,
  lastSyncStatus: 'idle',
}

const INITIAL_MEMORY_MD = `# Memory

## 核心背景

## 每次都要遵守

## Index
`

export const normalizeNewlines = (text: string) => text.replace(/\r\n?/g, '\n')

export const normalizeMemoryPath = (raw: string): string | null => {
  if (typeof raw !== 'string') {
    return null
  }
  let value = raw.normalize('NFC').replaceAll(String.fromCharCode(92), '/').trim()
  while (value.startsWith('./') || value.startsWith('/')) {
    value = value.replace(/^(?:\.\/|\/)+/, '')
  }
  if (!value || value.length > 240 || /^[A-Za-z]:/.test(value) || [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return null
  }
  if (!/\.md$/i.test(value)) {
    value += '.md'
  }
  const segments = value.split('/')
  if (segments.length > 4) {
    return null
  }
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.') || /[<>:"|?*]/.test(segment)) {
      return null
    }
    if (new TextEncoder().encode(segment).length > 120) {
      return null
    }
  }
  if (segments.length === 1 && segments[0].toLowerCase() === 'memory.md') {
    return 'MEMORY.md'
  }
  return value
}

export const stripMarkdownExtension = (path: string) => path.replace(/\.md$/i, '')

export const fileStem = (path: string) => {
  const name = path.split('/').at(-1) ?? path
  return stripMarkdownExtension(name)
}

export const memoryNoteTitle = (path: string) => fileStem(path)

export const resolveWikiTarget = (rawTarget: string): string | null => {
  const target = rawTarget.split('|')[0]?.trim() ?? ''
  return normalizeMemoryPath(target)
}

export const extractWikiLinks = (content: string): string[] => {
  const links: string[] = []
  const pattern = /\[\[([^\]\n]+)\]\]/g
  for (const match of content.matchAll(pattern)) {
    const target = resolveWikiTarget(match[1])
    if (target && !links.includes(target)) {
      links.push(target)
    }
  }
  return links
}

export const parseSourceMeta = (line: string): { text: string; source?: string; added?: string } => {
  const match = line.match(/^(.*?)(?:\s*)\[source:\s*([^;\]]+)(?:;\s*added:\s*([^\]]+))?\]\s*$/)
  if (!match) {
    return { text: line }
  }
  return {
    text: match[1].trimEnd(),
    source: match[2]?.trim(),
    added: match[3]?.trim(),
  }
}

export const normalizeFactLine = (line: string) =>
  parseSourceMeta(line.replace(/^\s*-\s*/, '').trim()).text.replace(/\s+/g, ' ').trim()

export const formatLocalDate = (time = Date.now()) => {
  const date = new Date(time)
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export const withSourceSuffix = (line: string, time = Date.now()) => {
  const clean = line.replace(/^\s*-\s*/, '').trim()
  if (!clean || /\[source:/i.test(clean)) {
    return clean
  }
  return `${clean} [source: elsewhere; added: ${formatLocalDate(time)}]`
}

const readConfigStorage = (): MemoryConfig => {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CONFIG
    }
    const raw = localStorage.getItem(MEMORY_CONFIG_STORAGE_KEY)
    if (!raw) {
      return DEFAULT_CONFIG
    }
    const parsed = JSON.parse(raw) as Partial<MemoryConfig> | null
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_CONFIG
    }
    return {
      enabled: parsed.enabled === true,
      syncMode: parsed.syncMode === 'github' ? 'github' : 'local',
      githubRepo: typeof parsed.githubRepo === 'string' ? parsed.githubRepo : '',
      githubBranch:
        typeof parsed.githubBranch === 'string' && parsed.githubBranch.trim()
          ? parsed.githubBranch.trim()
          : 'main',
      lastSyncedAt:
        typeof parsed.lastSyncedAt === 'number' && Number.isFinite(parsed.lastSyncedAt)
          ? parsed.lastSyncedAt
          : null,
      lastSyncCommitSha:
        typeof parsed.lastSyncCommitSha === 'string' ? parsed.lastSyncCommitSha : null,
      lastSyncStatus:
        parsed.lastSyncStatus === 'synced' ||
        parsed.lastSyncStatus === 'pending' ||
        parsed.lastSyncStatus === 'conflict' ||
        parsed.lastSyncStatus === 'error'
          ? parsed.lastSyncStatus
          : 'idle',
      ...(typeof parsed.lastSyncError === 'string' ? { lastSyncError: parsed.lastSyncError } : {}),
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

const persistConfig = (config: MemoryConfig) => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MEMORY_CONFIG_STORAGE_KEY, JSON.stringify(config))
    }
  } catch {
    // 存储受限时仅保留内存态
  }
}

type MemoryStoreState = {
  ready: boolean
  initError: boolean
  notes: Record<string, MemoryNote>
  config: MemoryConfig
  deletedPaths: DeletedMemoryPath[]
  dreamedSessions: Record<string, number>
  lastDreamApplied: MemoryDreamRun | null
}

export const useMemoryStore = create<MemoryStoreState>(() => ({
  ready: false,
  initError: false,
  notes: {},
  config: readConfigStorage(),
  deletedPaths: [],
  dreamedSessions: {},
  lastDreamApplied: null,
}))

const { getState: getMemory, setState: setMemory } = useMemoryStore

let initPromise: Promise<void> | null = null

const sortNotes = (notes: readonly MemoryNote[]) =>
  [...notes].sort((a, b) => {
    if (a.path === 'MEMORY.md') {
      return -1
    }
    if (b.path === 'MEMORY.md') {
      return 1
    }
    return a.path.localeCompare(b.path)
  })

export const initMemoryStore = async (): Promise<void> => {
  if (getMemory().ready) {
    return
  }
  if (initPromise) {
    return initPromise
  }
  initPromise = (async () => {
    try {
      const [notes, deletedPaths, dreamedSessions, lastDreamApplied] = await Promise.all([
        listMemoryNotes(),
        getDeletedMemoryPaths(),
        getDreamedSessions(),
        getLastDreamApplied(),
      ])
      const map = Object.fromEntries(notes.map((note) => [note.path, note]))
      if (getMemory().config.enabled && !map['MEMORY.md']) {
        const created: MemoryNote = {
          path: 'MEMORY.md',
          content: INITIAL_MEMORY_MD,
          updatedAt: Date.now(),
        }
        await putMemoryNote(created)
        map['MEMORY.md'] = created
      }
      setMemory({
        ready: true,
        initError: false,
        notes: map,
        deletedPaths: deletedPaths ?? [],
        dreamedSessions: dreamedSessions ?? {},
        lastDreamApplied: lastDreamApplied ?? null,
      })
    } catch {
      setMemory({ ready: true, initError: true })
    } finally {
      initPromise = null
    }
  })()
  return initPromise
}

export const ensureMemoryReady = () => void initMemoryStore()

export const updateMemoryConfig = (patch: Partial<MemoryConfig>) => {
  const config = { ...getMemory().config, ...patch }
  persistConfig(config)
  setMemory({ config })
  if (patch.enabled === true && !getMemory().notes['MEMORY.md']) {
    void saveMemoryNote('MEMORY.md', INITIAL_MEMORY_MD, { initialize: true })
  }
}

export const getMemorySecret = (): string => {
  try {
    if (android?.readMemorySyncSecret) {
      return android.readMemorySyncSecret() ?? ''
    }
    return typeof localStorage === 'undefined'
      ? ''
      : (localStorage.getItem(MEMORY_SECRET_STORAGE_KEY) ?? '')
  } catch {
    return ''
  }
}

export const setMemorySecret = (value: string): boolean => {
  const normalized = value.trim()
  try {
    if (android?.writeMemorySyncSecret) {
      return android.writeMemorySyncSecret(normalized || null)
    }
    if (typeof localStorage === 'undefined') {
      return false
    }
    if (normalized) {
      localStorage.setItem(MEMORY_SECRET_STORAGE_KEY, normalized)
    } else {
      localStorage.removeItem(MEMORY_SECRET_STORAGE_KEY)
    }
    return true
  } catch {
    return false
  }
}

const setNoteState = (note: MemoryNote) => {
  setMemory((state) => ({ notes: { ...state.notes, [note.path]: note } }))
}

const removeNoteState = (path: string) => {
  setMemory((state) => ({
    notes: Object.fromEntries(Object.entries(state.notes).filter(([key]) => key !== path)),
  }))
}

export const getMemoryNoteFromState = (path: string) => getMemory().notes[path]

export const saveMemoryNote = async (
  rawPath: string,
  content: string,
  options: { initialize?: boolean; markRemoteBase?: { sha?: string; baseContent?: string } } = {}
): Promise<MemoryNote | null> => {
  const path = normalizeMemoryPath(rawPath)
  if (!path) {
    return null
  }
  const normalizedContent = normalizeNewlines(content)
  const existing = getMemory().notes[path]
  const remoteSha = options.markRemoteBase?.sha ?? existing?.remoteSha
  const baseContent = options.markRemoteBase?.baseContent ?? existing?.baseContent
  const note: MemoryNote = {
    path,
    content: normalizedContent,
    updatedAt: Date.now(),
    ...(remoteSha ? { remoteSha } : {}),
    ...(baseContent ? { baseContent } : {}),
  }
  if (!options.initialize && existing?.content === normalizedContent) {
    return existing
  }
  await putMemoryNote(note)
  setNoteState(note)
  return note
}

export const upsertMemoryNote = async (note: MemoryNote) => {
  const normalized = normalizeMemoryPath(note.path)
  if (!normalized) {
    return null
  }
  const next = { ...note, path: normalized, content: normalizeNewlines(note.content) }
  await putMemoryNote(next)
  setNoteState(next)
  return next
}

export const replaceMemoryNotes = async (notes: readonly MemoryNote[]) => {
  await clearMemoryNotes()
  const normalized = notes
    .map((note) => {
      const path = normalizeMemoryPath(note.path)
      return path ? { ...note, path, content: normalizeNewlines(note.content) } : null
    })
    .filter((note): note is MemoryNote => note !== null)
  await putMemoryNotes(normalized)
  setMemory({ notes: Object.fromEntries(normalized.map((note) => [note.path, note])) })
}

export const removeMemoryNote = async (rawPath: string): Promise<boolean> => {
  const path = normalizeMemoryPath(rawPath)
  if (!path || path === 'MEMORY.md') {
    return false
  }
  const existing = getMemory().notes[path]
  await deleteMemoryNote(path)
  removeNoteState(path)
  const deleted: DeletedMemoryPath = {
    path,
    ...(existing?.remoteSha ? { remoteSha: existing.remoteSha } : {}),
    deletedAt: Date.now(),
  }
  const deletedPaths = [
    ...getMemory().deletedPaths.filter((item) => item.path !== path),
    deleted,
  ]
  await setDeletedMemoryPaths(deletedPaths)
  setMemory({ deletedPaths })
  return true
}

export const restoreMemoryTombstones = async (paths: readonly string[]) => {
  const next = getMemory().deletedPaths.filter((item) => !paths.includes(item.path))
  await setDeletedMemoryPaths(next)
  setMemory({ deletedPaths: next })
}

export const clearPushedMemoryTombstones = async (paths: readonly string[]) => {
  await restoreMemoryTombstones(paths)
}

export const markDreamedSessions = async (watermarks: Record<string, number>) => {
  const dreamedSessions = { ...getMemory().dreamedSessions, ...watermarks }
  await setDreamedSessions(dreamedSessions)
  setMemory({ dreamedSessions })
}

export const saveLastDreamApplied = async (value: MemoryDreamRun | null) => {
  await setLastDreamApplied(value)
  setMemory({ lastDreamApplied: value })
}

export const sortedMemoryNotes = () => sortNotes(Object.values(getMemory().notes))

export const searchMemoryNotes = (query: string, limit = 6) => {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return []
  }
  const matches: { path: string; lines: string[] }[] = []
  for (const note of sortedMemoryNotes()) {
    const lines = note.content
      .split('\n')
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.toLowerCase().includes(needle))
      .slice(0, 6)
      .map(({ line, index }) => `${index + 1}: ${line}`)
    if (lines.length > 0) {
      matches.push({ path: note.path, lines })
    }
    if (matches.length >= limit) {
      break
    }
  }
  return matches
}

export const isMemoryEffectivelyEnabled = (sessionMemoryEnabled?: boolean) =>
  getMemory().config.enabled && sessionMemoryEnabled === true
