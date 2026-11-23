import { DEFAULT_CHAT_MODEL, type ChatConfig } from '../services/api/chatConfig.js'
import { getActiveModelContextWindow } from './models/config.js'
import { getVisibleMessages } from '../services/chat/branches.js'
import {
  estimateBranchScale,
  estimateQuestionTokens,
  estimateTextTokens,
  WINDOW_TOKENS,
} from '../services/chat/context.js'
import { getContextRounds, getReplyText } from '../services/chat/reply.js'
import type { AssistantMessage, Message, Session } from '../services/chat/types.js'

const CUSTOM_CONTEXT_WINDOW = 128 * 1024
const WARNING_RATIO = 0.8
const FIXED_OVERHEAD = 256

export type ActiveCheckpointInfo = {
  replyId: string
  summary: string
  offset?: number
  summarizedRounds: number
  recentRounds: number
}

export type ContextStats = {
  hasMessages: boolean
  windowTokens: number
  usedTokens: number
  summaryTokens: number
  recentTokens: number
  ratio: number
  percent: number
  isWarning: boolean
  checkpoint: ActiveCheckpointInfo | null
  modelName: string
}

export const getActiveSummaryCheckpoint = (
  session: Session,
  visibleMessages: Message[]
): ActiveCheckpointInfo | null => {
  if (!session.contextCheckpoints?.length) {
    return null
  }
  const rounds = getContextRounds(visibleMessages)
  if (!rounds.length) {
    return null
  }
  const byReply = new Map(session.contextCheckpoints.map((checkpoint) => [checkpoint.replyId, checkpoint]))
  const index = rounds.findLastIndex(([, reply]) => byReply.has(reply.id))
  if (index < 0) {
    return null
  }
  const checkpoint = byReply.get(rounds[index][1].id)
  if (!checkpoint) {
    return null
  }
  const summarizedRounds = index + 1
  return {
    replyId: checkpoint.replyId,
    summary: checkpoint.summary,
    offset: checkpoint.offset,
    summarizedRounds,
    recentRounds: Math.max(0, rounds.length - summarizedRounds),
  }
}

const resolveActiveModel = (visibleMessages: Message[], chatConfig: ChatConfig): string => {
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const message = visibleMessages[i]
    if (message.role === 'assistant' && message.model) {
      return message.model
    }
  }
  return chatConfig.model || DEFAULT_CHAT_MODEL
}

const estimateMessageDelta = (message: Message, scale: number): number => {
  const scaleValue = (tokens: number) => (scale === 1 ? tokens : Math.ceil(tokens * scale))
  if (message.role === 'user') {
    return scaleValue(estimateQuestionTokens(message))
  }
  const links = message.blocks.filter((block) => block.type === 'web_fetch_tool_result').length
  return scaleValue(estimateTextTokens(getReplyText(message))) + links * 8_192 + 32
}

export const computeContextStats = (
  session: Session,
  chatConfig: ChatConfig,
  draftText = ''
): ContextStats => {
  const visibleMessages = getVisibleMessages(session)
  const custom = Boolean(chatConfig.endpoint)
  const modelWindow = getActiveModelContextWindow()
  const windowTokens = custom
    ? (modelWindow ?? CUSTOM_CONTEXT_WINDOW)
    : (modelWindow ?? WINDOW_TOKENS)
  const modelName = resolveActiveModel(visibleMessages, chatConfig)

  if (!visibleMessages.length) {
    return {
      hasMessages: false,
      windowTokens,
      usedTokens: 0,
      summaryTokens: 0,
      recentTokens: 0,
      ratio: 0,
      percent: 0,
      isWarning: false,
      checkpoint: null,
      modelName,
    }
  }

  const scale = estimateBranchScale(visibleMessages, modelName, session.contextCheckpoints)
  const scaleValue = (tokens: number) => (scale === 1 ? tokens : Math.ceil(tokens * scale))
  const checkpoint = getActiveSummaryCheckpoint(session, visibleMessages)
  const rawSummaryTokens = checkpoint ? scaleValue(estimateTextTokens(checkpoint.summary)) + 64 : 0
  const draftTokens = draftText ? scaleValue(estimateTextTokens(draftText)) : 0

  const cpMessageIndex = checkpoint
    ? visibleMessages.findIndex((message) => message.id === checkpoint.replyId)
    : -1

  let lastUsageIndex = -1
  for (let i = visibleMessages.length - 1; i >= 0; i--) {
    const message = visibleMessages[i]
    if (message.role === 'assistant' && message.usage) {
      lastUsageIndex = i
      break
    }
  }

  let usedTokens = 0
  // 只有当最近一次真实 usage 发生在最新摘要分界之后，才直接以它作为基线，避免误用压缩前旧 usage。
  if (lastUsageIndex >= 0 && lastUsageIndex > cpMessageIndex) {
    const reply = visibleMessages[lastUsageIndex] as AssistantMessage
    const usage = reply.usage
    const actualPrompt = usage
      ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens
      : 0
    usedTokens = actualPrompt + estimateMessageDelta(reply, scale)
    for (let i = lastUsageIndex + 1; i < visibleMessages.length; i++) {
      usedTokens += estimateMessageDelta(visibleMessages[i], scale)
    }
    usedTokens += draftTokens
  } else {
    const startIndex = cpMessageIndex >= 0 ? cpMessageIndex + 1 : 0
    usedTokens = FIXED_OVERHEAD + rawSummaryTokens + draftTokens
    for (let i = startIndex; i < visibleMessages.length; i++) {
      usedTokens += estimateMessageDelta(visibleMessages[i], scale)
    }
  }

  const summaryTokens = checkpoint ? Math.min(usedTokens, rawSummaryTokens) : 0
  const recentTokens = Math.max(0, usedTokens - summaryTokens)
  const ratio = windowTokens > 0 ? Math.min(1, usedTokens / windowTokens) : 0
  const percent = Math.min(100, Math.round((usedTokens / windowTokens) * 100))

  return {
    hasMessages: true,
    windowTokens,
    usedTokens,
    summaryTokens,
    recentTokens,
    ratio,
    percent,
    isWarning: ratio >= WARNING_RATIO,
    checkpoint,
    modelName,
  }
}

export const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_048_576 && tokens % 1_048_576 === 0) {
    return `${tokens / 1_048_576}M`
  }
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 100_000) {
    return `${Math.round(tokens / 1_000)}k`
  }
  if (tokens >= 1_000) {
    const kilo = tokens / 1_000
    return `${kilo >= 100 ? Math.round(kilo) : Number(kilo.toFixed(1))}k`
  }
  return String(tokens)
}
