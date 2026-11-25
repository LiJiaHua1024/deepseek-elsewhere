import { streamChatMessage } from '../../services/api/client.js'
import { DEFAULT_CHAT_MODEL } from '../../services/api/chatConfig.js'
import * as chatDb from '../../services/chat/db.js'
import { getVisibleMessages } from '../../services/chat/branches.js'
import { initChat, useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { putMemoryNotes } from './db.js'
import { mutateMemoryContent } from './repositoryOps.js'
import {
  fileStem,
  initMemoryStore,
  markDreamedSessions,
  normalizeMemoryPath,
  saveLastDreamApplied,
  sortedMemoryNotes,
  useMemoryStore,
} from './store.js'
import type { MemoryDreamProposal, MemoryNote } from './types.js'

export type DreamSessionCandidate = {
  id: string
  title: string
  updatedAt: number
}

export type DreamRunResult = {
  candidates: DreamSessionCandidate[]
  proposals: MemoryDreamProposal[]
  rawText: string
}

const MAX_DREAM_SESSIONS = 12
const MAX_SESSION_CHARS = 2600
const MAX_MEMORY_CHARS = 8000

export const listUndreamedSessions = async (): Promise<DreamSessionCandidate[]> => {
  await Promise.all([initChat(), initMemoryStore()])
  const watermarks = useMemoryStore.getState().dreamedSessions
  return useChatStore
    .getState()
    .sessions.filter((session) => (watermarks[session.id] ?? 0) < session.updatedAt)
    .slice(0, MAX_DREAM_SESSIONS)
    .map((session) => ({
      id: session.id,
      title: session.title || '未命名对话',
      updatedAt: session.updatedAt,
    }))
}

const messageText = (message: ReturnType<typeof getVisibleMessages>[number]): string => {
  if (message.role === 'user') {
    return message.content
  }
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

const loadDreamTranscript = async (candidate: DreamSessionCandidate): Promise<string> => {
  const session = await chatDb.loadSession(candidate.id)
  if (!session) {
    return ''
  }
  const rows: string[] = []
  for (const message of getVisibleMessages(session)) {
    const text = messageText(message).trim()
    if (!text) {
      continue
    }
    rows.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
    if (rows.join('\n').length >= MAX_SESSION_CHARS) {
      break
    }
  }
  return rows.join('\n').slice(0, MAX_SESSION_CHARS)
}

const compactMemory = () => {
  const notes = sortedMemoryNotes()
  const text = notes
    .map((note) => `--- ${note.path} ---\n${note.content.trim()}`)
    .join('\n\n')
  return text.slice(0, MAX_MEMORY_CHARS)
}

const dreamInstructions = `你是聊天记忆整理器。根据给定对话和现有 Markdown 记忆，提出值得长期保留的变更。只记录稳定的事实、偏好、决定、项目背景或学习进度；不要记录一次性闲聊、密码、密钥或助手猜测。能更新旧条目就不要追加重复条目。输出必须是严格 JSON 数组，不要输出 Markdown 代码块或解释。数组元素格式：{"file":"preferences.md","action":"add|update|remove","oldText":"要替换或删除的完全一致原文，可省略","newText":"新增或替换后的文本，可省略","reason":"简短原因"}。file 必须是相对 Markdown 路径；update/remove 的 oldText 必须逐字存在于当前记忆；add 用于向已有笔记追加一条，或创建不存在的新笔记。新建主题笔记时，同时提出一条 MEMORY.md 的 add 提案，用 [[路径去掉.md]] 链接它。没有值得保留的内容时输出 []。`

const extractJsonArray = (text: string): unknown[] => {
  const trimmed = text.trim()
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim()
    : trimmed
  try {
    const parsed: unknown = JSON.parse(withoutFence)
    if (Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    const start = withoutFence.indexOf('[')
    const end = withoutFence.lastIndexOf(']')
    if (start >= 0 && end > start) {
      const parsed: unknown = JSON.parse(withoutFence.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        return parsed
      }
    }
  }
  throw new Error('模型没有返回可解析的 JSON 数组')
}

export const parseDreamProposals = (text: string): MemoryDreamProposal[] => {
  const rawItems = extractJsonArray(text)
  const proposals: MemoryDreamProposal[] = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') {
      continue
    }
    const item = raw as Record<string, unknown>
    const file = normalizeMemoryPath(typeof item.file === 'string' ? item.file : '')
    const action = item.action
    if (!file || (action !== 'add' && action !== 'update' && action !== 'remove')) {
      continue
    }
    const proposal: MemoryDreamProposal = {
      file,
      action,
      ...(typeof item.section === 'string' && item.section.trim()
        ? { section: item.section.trim() }
        : {}),
      ...(typeof item.oldText === 'string' && item.oldText ? { oldText: item.oldText } : {}),
      ...(typeof item.newText === 'string' && item.newText ? { newText: item.newText } : {}),
      reason:
        typeof item.reason === 'string' && item.reason.trim()
          ? item.reason.trim()
          : '模型建议更新',
    }
    proposals.push(proposal)
  }
  return proposals
}

export const validateDreamProposals = (
  proposals: readonly MemoryDreamProposal[],
  notes: readonly MemoryNote[]
): MemoryDreamProposal[] => {
  const byPath = new Map(notes.map((note) => [note.path, note.content]))
  const valid = proposals.filter((proposal) => {
    const content = byPath.get(proposal.file)
    if (proposal.action === 'add') {
      return Boolean(proposal.newText?.trim())
    }
    if (!content || !proposal.oldText) {
      return false
    }
    return content.includes(proposal.oldText)
  })
  const result = [...valid]
  const hasIndexProposal = result.some((proposal) => proposal.file === 'MEMORY.md')
  const created = result.find(
    (proposal) =>
      proposal.action === 'add' && proposal.file !== 'MEMORY.md' && !byPath.has(proposal.file)
  )
  if (created && !hasIndexProposal) {
    const link = created.file.replace(/\.md$/i, '')
    result.push({
      file: 'MEMORY.md',
      action: 'add',
      newText: `- [[${link}]] ${fileStem(created.file)}`,
      reason: '为新主题笔记补充主索引链接',
    })
  }
  return result
}

const collectStreamText = async (
  stream: AsyncIterable<import('../../services/api/types.js').MessageStreamEvent>
) => {
  let text = ''
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text
}

export const runDreaming = async ({
  signal,
}: {
  signal?: AbortSignal
} = {}): Promise<DreamRunResult> => {
  await Promise.all([initChat(), initMemoryStore()])
  const candidates = await listUndreamedSessions()
  if (candidates.length === 0) {
    return { candidates, proposals: [], rawText: '[]' }
  }
  const transcripts: string[] = []
  for (const candidate of candidates) {
    const transcript = await loadDreamTranscript(candidate)
    if (transcript) {
      transcripts.push(`--- 对话：${candidate.title} ---\n${transcript}`)
    }
  }
  if (transcripts.length === 0) {
    return { candidates, proposals: [], rawText: '[]' }
  }
  const { apiKey: storedKey, chatConfig } = useSettings.getState()
  const controller = new AbortController()
  const unlink = signal?.addEventListener('abort', () => controller.abort(signal.reason), {
    once: true,
  })
  try {
    const body = {
      model: chatConfig.model || DEFAULT_CHAT_MODEL,
      max_tokens: 4096,
      system: dreamInstructions,
      messages: [
        {
          role: 'user' as const,
          content: `现有记忆：\n${compactMemory() || '（空）'}\n\n待整理对话：\n${transcripts.join('\n\n')}`,
        },
      ],
      thinking: { type: 'disabled' as const },
    }
    const rawText = await collectStreamText(
      streamChatMessage(chatConfig, storedKey ?? '', body, controller.signal)
    )
    const parsed = parseDreamProposals(rawText)
    const proposals = validateDreamProposals(parsed, sortedMemoryNotes())
    return { candidates, proposals, rawText }
  } finally {
    void unlink
  }
}

export const applyDreamProposals = async (
  proposals: readonly MemoryDreamProposal[],
  candidates: readonly DreamSessionCandidate[]
): Promise<number> => {
  await initMemoryStore()
  if (proposals.length === 0) {
    return 0
  }
  const existing = new Map(sortedMemoryNotes().map((note) => [note.path, note]))
  const working = new Map([...existing.entries()].map(([path, note]) => [path, note.content]))
  const writes = new Map<string, MemoryNote>()
  for (const proposal of proposals) {
    const path = normalizeMemoryPath(proposal.file)
    if (!path) {
      throw new Error('整理结果包含无效路径')
    }
    const current = working.get(path)
    const text = proposal.newText ?? proposal.oldText ?? ''
    if (proposal.action === 'add') {
      if (current === undefined) {
        const created = mutateMemoryContent({
          path,
          mode: 'create',
          content: null,
          text: `# ${fileStem(path)}\n`,
        })
        if (!created.ok) {
          throw new Error(created.message)
        }
        working.set(path, created.nextContent)
      }
      const appended = mutateMemoryContent({
        path,
        mode: 'append',
        content: working.get(path) ?? '',
        text,
      })
      if (!appended.ok) {
        throw new Error(appended.message)
      }
      working.set(path, appended.nextContent)
    } else if (proposal.action === 'update') {
      const updated = mutateMemoryContent({
        path,
        mode: 'replace',
        content: current ?? null,
        oldText: proposal.oldText,
        newText: proposal.newText ?? '',
      })
      if (!updated.ok) {
        throw new Error(updated.message)
      }
      working.set(path, updated.nextContent)
    } else {
      const removed = mutateMemoryContent({
        path,
        mode: 'delete_line',
        content: current ?? null,
        text: proposal.oldText ?? proposal.newText,
      })
      if (!removed.ok) {
        throw new Error(removed.message)
      }
      working.set(path, removed.nextContent)
    }
    const previous = existing.get(path)
    writes.set(path, {
      path,
      content: working.get(path) ?? '',
      updatedAt: Date.now(),
      ...(previous?.remoteSha ? { remoteSha: previous.remoteSha } : {}),
      ...(previous?.baseContent ? { baseContent: previous.baseContent } : {}),
    })
  }
  const changed = [...writes.values()].filter(
    (note) => note.content !== existing.get(note.path)?.content
  )
  if (changed.length > 0) {
    await putMemoryNotes(changed)
    useMemoryStore.setState((state) => ({
      notes: {
        ...state.notes,
        ...Object.fromEntries(changed.map((note) => [note.path, note])),
      },
    }))
  }
  const watermarks = Object.fromEntries(candidates.map((item) => [item.id, item.updatedAt]))
  await markDreamedSessions(watermarks)
  await saveLastDreamApplied({
    appliedAt: Date.now(),
    sessionCount: candidates.length,
    items: proposals.map((item) => ({ ...item })),
  })
  return changed.length
}
