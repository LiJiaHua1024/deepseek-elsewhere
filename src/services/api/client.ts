import { android } from '../../app/android.js'
import type { ReasoningEffort } from '../../elsewhere/models/types.js'
import {
  isLocalDateReminder,
  isToolResultOnlyUserContent,
  prependReminderToUserContent,
} from '../../elsewhere/tools/systemTime.js'
import { translate, type TranslationMessage } from '../../i18n/index.js'
import { CHAT_API_PATHS, type ChatConfig } from './chatConfig.js'
import { createOpenAIStreamAdapter, openAIRequest, readOpenAIFrame } from './openaiChat.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      code = typeof body.error.code === 'string' ? body.error.code : undefined
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (
  apiKey: string,
  fileId: string,
  signal?: AbortSignal
): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
    signal,
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      message.role === 'user' &&
      typeof message.content !== 'string' &&
      message.content.some(
        (block) =>
          (block.type === 'image' || block.type === 'document') && block.source.type === 'file'
      )
  )

export const serializeOfficialAnthropicBody = (body: CreateMessageRequest) => {
  const {
    model,
    max_tokens,
    system,
    messages,
    thinking,
    tools,
    clientTools,
    safety_check,
    title,
  } = body
  const officialMessages = messages.filter(
    (message) => !(message.role === 'latest_reminder' && isLocalDateReminder(message.content))
  )
  const base = {
    model,
    max_tokens,
    system,
    messages: officialMessages,
    thinking,
    ...(safety_check ? { safety_check } : {}),
    ...(title ? { title } : {}),
  }
  if (clientTools?.length) {
    return JSON.stringify({
      ...base,
      tools: clientTools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      stream: true,
    })
  }
  return JSON.stringify({
    ...base,
    ...(tools ? { tools } : {}),
    stream: true,
  })
}

const openMessageStream = (apiKey: string, body: CreateMessageRequest, signal: AbortSignal) =>
  request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: serializeOfficialAnthropicBody(body),
    signal,
  })

const withDeepSeekExtensionsFallback = (
  body: CreateMessageRequest,
  send: (requestBody: CreateMessageRequest) => Promise<Response>
) =>
  send(body).catch((error: unknown) => {
    if (
      !(
        body.tools?.length ||
        body.clientTools?.length ||
        body.safety_check ||
        body.title?.enabled
      ) ||
      !(error instanceof ApiError) ||
      error.status !== 400 ||
      !/\buser input too long, \d+ tokens exceeds max 32768 tokens\b/i.test(error.message)
    ) {
      throw error
    }
    // 扩展模式在生成前拒绝长输入时，用同一协议的基础模式发送同一上下文。
    return send({
      ...body,
      tools: undefined,
      clientTools: undefined,
      safety_check: undefined,
      title: undefined,
    })
  })

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
async function* streamMessage(apiKey: string, body: CreateMessageRequest, signal: AbortSignal) {
  const response = await withDeepSeekExtensionsFallback(body, (requestBody) =>
    openMessageStream(apiKey, requestBody, signal)
  )
  yield* readAnthropicStream(response, signal)
}

async function* readStreamPayloads(response: Response, signal: AbortSignal) {
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.toLowerCase().includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    signal.throwIfAborted()
    if (data === '[DONE]') {
      yield { done: true } as const
      return
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      const { message, code } = payload.error
      throw new ApiError('stream', message, undefined, typeof code === 'string' ? code : undefined)
    }
    if (eventName === 'error' && !payload) {
      throw new ApiError('stream', data)
    }
    yield { done: false, payload, eventName, data } as const
  }
  signal.throwIfAborted()
}

async function* readAnthropicStream(response: Response, signal: AbortSignal) {
  for await (const frame of readStreamPayloads(response, signal)) {
    if (frame.done) {
      break
    }
    const { payload, eventName, data } = frame
    if (eventName === 'error') {
      const detail = payload as { error?: { message?: unknown; type?: unknown } } | null
      const error = detail?.error
      throw new ApiError(
        'stream',
        typeof error?.message === 'string' ? error.message : data,
        undefined,
        typeof error?.type === 'string' ? error.type : undefined
      )
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}

export const resolveAnthropicThinkingBudget = (effort?: ReasoningEffort): number => {
  switch (effort) {
    case 'low':
      return 2_048
    case 'high':
      return 16_384
    case 'medium':
    case 'auto':
    default:
      return 8_192
  }
}

export const isUnsupportedThinkingParamError = (error: unknown): boolean => {
  if (!(error instanceof ApiError) || error.status !== 400) {
    return false
  }
  const message = error.message
  if (/(?:reasoning_effort|reasoning\.effort|budget_tokens)/i.test(message)) {
    return true
  }
  return (
    /\bthinking\b/i.test(message) &&
    /(?:unsupported|unknown|unrecognized|invalid|not\s+(?:allowed|supported|permitted|available)|extra|unexpected|disable|param|field|argument)/i.test(
      message
    )
  )
}

export const customMessagesRequest = ({
  model,
  system,
  messages,
  max_tokens,
  clientTools,
  thinking,
  reasoningEffort,
}: CreateMessageRequest) => {
  const thinkingEnabled = thinking.type === 'enabled'
  const budgetTokens = resolveAnthropicThinkingBudget(reasoningEffort)
  const resolvedMaxTokens = thinkingEnabled
    ? Math.max(max_tokens, budgetTokens + 4_096)
    : max_tokens
  let pendingReminder: string | undefined
  const serializedMessages: CreateMessageRequest['messages'] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      pendingReminder = message.content
      continue
    }
    if (message.role === 'assistant') {
      pendingReminder = undefined
      const content = message.content.filter((block) => {
        if (block.type === 'text' || block.type === 'tool_use') {
          return true
        }
        return block.type === 'thinking' && Boolean(block.signature)
      })
      if (content.length) {
        serializedMessages.push({ ...message, content })
      }
      continue
    }
    if (pendingReminder && !isToolResultOnlyUserContent(message.content)) {
      serializedMessages.push({
        ...message,
        content: prependReminderToUserContent(message.content, pendingReminder),
      })
      pendingReminder = undefined
      continue
    }
    serializedMessages.push(message)
  }
  return {
    model,
    system: system || undefined,
    max_tokens: resolvedMaxTokens,
    messages: serializedMessages,
    ...(thinkingEnabled
      ? { thinking: { type: 'enabled' as const, budget_tokens: budgetTokens } }
      : {}),
    ...(clientTools?.length
      ? {
          tools: clientTools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })),
        }
      : {}),
    stream: true,
  }
}

type NativeChatEvent = { id: string } & (
  | { type: 'headers'; status: number; mime: string }
  | { type: 'data'; bytes: string }
  | { type: 'end' | 'error' }
)

const openAndroidChat = (
  device: NonNullable<typeof android>,
  config: ChatConfig,
  body: string,
  signal: AbortSignal
) => {
  let id: string | null = null
  let headersReceived = false
  let receiver: ReadableStreamDefaultController<Uint8Array>
  let resolve: (response: Response) => void
  let reject: (error: unknown) => void
  const response = new Promise<Response>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  const close = () => {
    window.removeEventListener('android-custom-chat', onChunk)
    signal.removeEventListener('abort', onAbort)
    if (id) {
      device.cancelChatRequest(id)
      id = null
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      receiver = controller
    },
    cancel: close,
  })
  const fail = (error: unknown) => {
    close()
    if (headersReceived) {
      receiver.error(error)
    } else {
      reject(error)
    }
  }
  const onAbort = () => fail(signal.reason)
  const onChunk = (event: Event) => {
    const chunk = (event as CustomEvent<NativeChatEvent>).detail
    if (chunk?.id !== id) {
      return
    }
    switch (chunk.type) {
      case 'headers': {
        headersReceived = true
        const bodyStream = chunk.status === 204 || chunk.status === 205 ? null : stream
        resolve(
          new Response(bodyStream, {
            status: chunk.status,
            headers: { 'Content-Type': chunk.mime },
          })
        )
        break
      }
      case 'data':
        receiver.enqueue(Uint8Array.from(atob(chunk.bytes), (char) => char.charCodeAt(0)))
        break
      case 'end':
        close()
        receiver.close()
        break
      case 'error':
        fail(new ApiError('network', ''))
        break
    }
  }
  window.addEventListener('android-custom-chat', onChunk)
  signal.addEventListener('abort', onAbort, { once: true })
  id = device.beginChatRequest(config.endpoint, config.format, body)
  if (!id) {
    fail(new ApiError('protocol', { key: 'advancedConnectionChanged' }))
  }
  return { response, close }
}

export const streamChatMessage = (
  config: ChatConfig,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
) => {
  if (config.endpoint) {
    return streamCompatibleMessage(config, body, signal, false)
  }
  if (config.format === 'messages') {
    return streamMessage(apiKey, body, signal)
  }
  const endpoint = `${API_ORIGIN}${CHAT_API_PATHS[config.format]}`
  return streamCompatibleMessage({ ...config, endpoint, apiKey }, body, signal, true)
}

async function* streamCompatibleMessage(
  config: ChatConfig,
  body: CreateMessageRequest,
  signal: AbortSignal,
  deepSeek: boolean
): AsyncGenerator<MessageStreamEvent> {
  const { endpoint, format, apiKey } = config
  const serialize = (requestBody: CreateMessageRequest) =>
    JSON.stringify(
      format === 'messages'
        ? customMessagesRequest(requestBody)
        : openAIRequest(format, requestBody, deepSeek)
    )
  signal.throwIfAborted()
  let activeNative: ReturnType<typeof openAndroidChat> | undefined
  const send = (requestBody: CreateMessageRequest) =>
    request(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        ...(format === 'messages'
          ? {
              'anthropic-version': '2023-06-01',
              ...(apiKey ? { 'x-api-key': apiKey } : {}),
              ...(new URL(endpoint).hostname === 'api.anthropic.com'
                ? { 'anthropic-dangerous-direct-browser-access': 'true' }
                : {}),
            }
          : apiKey
            ? { Authorization: `Bearer ${apiKey}` }
            : {}),
      },
      body: serialize(requestBody),
      credentials: 'omit',
      redirect: 'error',
      signal,
    })

  const openAttempt = async (requestBody: CreateMessageRequest): Promise<Response> => {
    if (android && !deepSeek) {
      const attempt = openAndroidChat(android, config, serialize(requestBody), signal)
      activeNative = attempt
      const res = await attempt.response
      if (!res.ok) {
        const error = await readErrorResponse(res, 'http', `HTTP ${res.status}`)
        attempt.close()
        if (activeNative === attempt) {
          activeNative = undefined
        }
        throw error
      }
      return res
    }
    return deepSeek ? withDeepSeekExtensionsFallback(requestBody, send) : send(requestBody)
  }

  try {
    let response: Response
    try {
      response = await openAttempt(body)
    } catch (error) {
      if (
        !deepSeek &&
        body.thinking.type === 'enabled' &&
        !signal.aborted &&
        isUnsupportedThinkingParamError(error)
      ) {
        response = await openAttempt({ ...body, thinking: { type: 'disabled' } })
      } else {
        throw error
      }
    }
    if (!response.ok) {
      throw await readErrorResponse(response, 'http', `HTTP ${response.status}`)
    }
    if (format === 'messages') {
      yield* readAnthropicStream(response, signal)
      return
    }
    const adapter = createOpenAIStreamAdapter()
    let complete = false
    for await (const packet of readStreamPayloads(response, signal)) {
      if (packet.done) {
        complete = format === 'chat' && (adapter.hasOutput() || adapter.getStop() !== undefined)
        break
      }
      const frame = readOpenAIFrame(format, packet.payload)
      if (frame.error) {
        throw new ApiError('stream', frame.error.message, undefined, frame.error.code)
      }
      if (packet.eventName === 'error') {
        throw new ApiError('stream', packet.data)
      }
      for (const event of adapter.push(frame)) {
        yield event
      }
      if (frame.done) {
        complete = true
        break
      }
    }
    if (!complete && !(format === 'chat' && adapter.getStop())) {
      throw new ApiError('interrupted', '')
    }
    for (const event of adapter.finish()) {
      yield event
    }
  } finally {
    activeNative?.close()
  }
}
