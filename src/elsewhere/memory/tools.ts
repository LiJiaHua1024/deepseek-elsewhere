import type { ClientToolDefinition } from '../tools/types.js'
import { mutateMemoryContent } from './repositoryOps.js'
import {
  getMemoryNoteFromState,
  initMemoryStore,
  normalizeMemoryPath,
  saveMemoryNote,
  searchMemoryNotes,
  stripMarkdownExtension,
} from './store.js'

const MAX_READ_CHARS = 12000

const truncate = (text: string, max = MAX_READ_CHARS) =>
  text.length > max ? `${text.slice(0, max)}\n…（内容已截断）` : text

const validLimit = (value: unknown) => {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) {
    return 6
  }
  return Math.max(1, Math.min(12, Math.floor(parsed)))
}

export const createMemoryReadTool = (): ClientToolDefinition => ({
  name: 'memory_read',
  description:
    'Read one durable chat-memory note by Markdown path. Use MEMORY.md first when you need the memory index. Paths are relative Markdown paths such as preferences.md or subjects/physics.md. Do not use this for ordinary conversation history; memory contains only curated long-term facts and preferences.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative Markdown note path, for example MEMORY.md or subjects/physics.md.',
      },
    },
    required: ['path'],
  },
  source: 'builtin',
  readOnly: true,
  execute: async (input) => {
    await initMemoryStore()
    const path = normalizeMemoryPath(typeof input.path === 'string' ? input.path : '')
    if (!path) {
      return {
        content: 'Invalid memory path. Use a short relative Markdown path such as MEMORY.md.',
        isError: true,
        meta: { kind: 'memory', operation: 'read' },
      }
    }
    const note = getMemoryNoteFromState(path)
    if (!note) {
      return {
        content: `Memory note not found: ${path}`,
        isError: true,
        meta: { kind: 'memory', operation: 'read', path },
      }
    }
    const truncated = note.content.length > MAX_READ_CHARS
    return {
      content: truncate(note.content),
      meta: {
        kind: 'memory',
        operation: 'read',
        path,
        ...(truncated ? { truncated: true } : {}),
      },
    }
  },
})

export const createMemorySearchTool = (): ClientToolDefinition => ({
  name: 'memory_search',
  description:
    'Search durable chat-memory notes with a case-insensitive substring query. Use this when the memory index is insufficient or you do not know which note contains a fact. Returns matching file paths and matching lines only.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Case-insensitive text to search in memory notes.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 12,
        description: 'Maximum number of matching files. Defaults to 6.',
      },
    },
    required: ['query'],
  },
  source: 'builtin',
  readOnly: true,
  execute: async (input) => {
    await initMemoryStore()
    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) {
      return {
        content: 'Missing required parameter: query',
        isError: true,
        meta: { kind: 'memory', operation: 'search' },
      }
    }
    const matches = searchMemoryNotes(query, validLimit(input.limit))
    const content =
      matches.length === 0
        ? `No memory matches for: ${query}`
        : matches
            .map((match) => `## ${match.path}\n${match.lines.join('\n')}`)
            .join('\n\n')
    return {
      content,
      meta: {
        kind: 'memory',
        operation: 'search',
        query,
        resultCount: matches.length,
      },
    }
  },
})

export const previewMemoryWriteInput = (input: Record<string, unknown>) => {
  const path = normalizeMemoryPath(typeof input.path === 'string' ? input.path : '')
  const mode = typeof input.mode === 'string' ? input.mode : ''
  if (!path) {
    return { ok: false as const, message: '路径无效', diffText: '' }
  }
  if (mode !== 'append' && mode !== 'replace' && mode !== 'delete_line' && mode !== 'create') {
    return { ok: false as const, path, message: '写入模式无效', diffText: '' }
  }
  const existing = getMemoryNoteFromState(path)
  const mutation = mutateMemoryContent({
    path,
    mode,
    content: existing?.content ?? null,
    text: typeof input.text === 'string' ? input.text : undefined,
    oldText: typeof input.oldText === 'string' ? input.oldText : undefined,
    newText: typeof input.newText === 'string' ? input.newText : undefined,
  })
  if (!mutation.ok) {
    return { ok: false as const, path, message: mutation.message, diffText: '' }
  }
  return {
    ok: true as const,
    path,
    message: mutation.result.message,
    diffText: mutation.result.diffText,
  }
}

export const createMemoryWriteTool = (): ClientToolDefinition => ({
  name: 'memory_write',
  description:
    'Write durable chat memory only for stable user facts, preferences, decisions, or reusable project context. Do not store transient conversation details or secrets. Modes: append adds one deduplicated bullet with source metadata; create creates a missing note; replace replaces exact oldText once; delete_line removes an exactly matching line. Keep Markdown concise and link related notes with [[path]]. Never overwrite unrelated content.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative Markdown note path, for example preferences.md or MEMORY.md.',
      },
      mode: {
        type: 'string',
        enum: ['append', 'replace', 'delete_line', 'create'],
        description: 'Write operation. Use append for a new stable fact.',
      },
      text: {
        type: 'string',
        description: 'Text to append/create, or exact line to delete for delete_line.',
      },
      oldText: {
        type: 'string',
        description: 'Exact existing text to replace, or exact line to delete.',
      },
      newText: {
        type: 'string',
        description: 'Replacement text for replace mode.',
      },
    },
    required: ['path', 'mode'],
  },
  source: 'builtin',
  readOnly: false,
  execute: async (input) => {
    await initMemoryStore()
    const path = normalizeMemoryPath(typeof input.path === 'string' ? input.path : '')
    const mode = typeof input.mode === 'string' ? input.mode : ''
    if (!path) {
      return {
        content: 'Invalid memory path. Use a short relative Markdown path.',
        isError: true,
        meta: { kind: 'memory', operation: 'write' },
      }
    }
    if (mode !== 'append' && mode !== 'replace' && mode !== 'delete_line' && mode !== 'create') {
      return {
        content: 'Invalid mode. Expected append, replace, delete_line, or create.',
        isError: true,
        meta: { kind: 'memory', operation: 'write', path },
      }
    }
    const existing = getMemoryNoteFromState(path)
    const mutation = mutateMemoryContent({
      path,
      mode,
      content: existing?.content ?? null,
      text: typeof input.text === 'string' ? input.text : undefined,
      oldText: typeof input.oldText === 'string' ? input.oldText : undefined,
      newText: typeof input.newText === 'string' ? input.newText : undefined,
    })
    if (!mutation.ok) {
      return {
        content: mutation.message,
        isError: true,
        meta: {
          kind: 'memory',
          operation: 'write',
          path,
          writeMode: mode,
          changed: false,
        },
      }
    }
    if (mutation.nextContent !== existing?.content) {
      await saveMemoryNote(path, mutation.nextContent)
    }
    return {
      content: `${mutation.result.message}: ${stripMarkdownExtension(path)}\n${mutation.result.diffText}`,
      meta: {
        kind: 'memory',
        operation: 'write',
        path,
        writeMode: mode,
        diffText: mutation.result.diffText,
        changed: mutation.result.changed,
      },
    }
  },
})

export const createMemoryTools = (): ClientToolDefinition[] => [
  createMemoryReadTool(),
  createMemorySearchTool(),
  createMemoryWriteTool(),
]
