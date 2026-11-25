import { unzipSync } from 'fflate'
import { writeArchive } from '../../services/chat/history/zipWriter.js'
import type { MemoryNote } from './types.js'
import { normalizeMemoryPath, normalizeNewlines } from './store.js'

export type MemoryArchiveImportEntry = {
  path: string
  content: string
}

export type MemoryArchiveImportResult = {
  entries: MemoryArchiveImportEntry[]
  ignored: string[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const stripSingleTopLevel = (path: string, topLevel: string | null) => {
  if (!topLevel) {
    return path
  }
  const prefix = `${topLevel}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

export const parseMemoryArchiveBytes = (bytes: Uint8Array): MemoryArchiveImportResult => {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes)
  } catch {
    throw new Error('压缩包无法读取')
  }
  const names = Object.keys(files).filter((name) => !name.endsWith('/'))
  const firstSegments = names
    .map((name) => name.replaceAll(String.fromCharCode(92), '/').split('/')[0])
    .filter(Boolean)
  const topLevel =
    firstSegments.length > 0 && firstSegments.every((segment) => segment === firstSegments[0])
      ? firstSegments[0]
      : null
  const entries: MemoryArchiveImportEntry[] = []
  const ignored: string[] = []
  const seen = new Set<string>()
  for (const rawName of names) {
    let normalizedName = rawName.normalize('NFC').replaceAll(String.fromCharCode(92), '/')
    while (normalizedName.startsWith('/')) {
      normalizedName = normalizedName.slice(1)
    }
    if (
      normalizedName.startsWith('.git/') ||
      normalizedName.includes('/.git/') ||
      !/\.md$/i.test(normalizedName)
    ) {
      ignored.push(rawName)
      continue
    }
    const stripped = stripSingleTopLevel(normalizedName, topLevel)
    const path = normalizeMemoryPath(stripped)
    if (!path || seen.has(path)) {
      ignored.push(rawName)
      continue
    }
    seen.add(path)
    entries.push({ path, content: normalizeNewlines(decoder.decode(files[rawName])) })
  }
  entries.sort((a, b) => {
    if (a.path === 'MEMORY.md') {
      return -1
    }
    if (b.path === 'MEMORY.md') {
      return 1
    }
    return a.path.localeCompare(b.path)
  })
  return { entries, ignored }
}

export const exportMemoryArchive = async (notes: readonly MemoryNote[]): Promise<Blob> =>
  writeArchive(
    notes.map((note) => ({
      name: note.path,
      blob: new Blob([encoder.encode(normalizeNewlines(note.content))], {
        type: 'text/markdown;charset=utf-8',
      }),
    }))
  )

export const conflictArchivePath = (path: string, time = Date.now()): string => {
  const stamp = new Date(time)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)
  const slash = path.lastIndexOf('/')
  const dir = slash >= 0 ? `${path.slice(0, slash + 1)}` : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const stem = name.replace(/\.md$/i, '')
  return `${dir}${stem}.conflict-${stamp}.md`
}

export const planMemoryArchiveMerge = ({
  existing,
  imported,
  now = Date.now(),
}: {
  existing: readonly Pick<MemoryNote, 'path' | 'content'>[]
  imported: readonly MemoryArchiveImportEntry[]
  now?: number
}) => {
  const current = new Map(existing.map((note) => [note.path, note.content]))
  const writes: MemoryArchiveImportEntry[] = []
  const conflicts: MemoryArchiveImportEntry[] = []
  let unchanged = 0
  for (const entry of imported) {
    const existingContent = current.get(entry.path)
    if (existingContent === undefined) {
      writes.push(entry)
    } else if (existingContent === entry.content) {
      unchanged += 1
    } else {
      conflicts.push({ path: conflictArchivePath(entry.path, now), content: entry.content })
    }
  }
  return { writes, conflicts, unchanged }
}
