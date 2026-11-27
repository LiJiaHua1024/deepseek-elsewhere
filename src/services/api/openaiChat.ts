import {
  isLocalDateReminder,
  prependReminderToUserContent,
} from '../../elsewhere/tools/systemTime.js'
import type { ChatApiFormat } from './chatConfig.js'
import type {
  ClientToolUseBlockParam,
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
  ToolResultBlockParam,
  UserBlockParam,
} from './types.js'

type OpenAIFormat = Exclude<ChatApiFormat, 'messages'>
type RegularUserBlock = Exclude<UserBlockParam, ToolResultBlockParam>

const userPart = (format: OpenAIFormat, block: RegularUserBlock, deepSeek: boolean) => {
  if (block.type === 'text') {
    return { type: format === 'chat' ? 'text' : 'input_text', text: block.text }
  }
  const { source } = block
  if (source.type === 'file') {
    if (!deepSeek) {
      return null
    }
    const type = format === 'chat' ? 'file' : block.type === 'image' ? 'input_image' : 'input_file'
    return { type, file_id: source.file_id }
  }
  const url = `data:${source.media_type};base64,${source.data}`
  if (block.type === 'image') {
    return format === 'chat'
      ? { type: 'image_url', image_url: { url } }
      : { type: 'input_image', image_url: url, detail: 'auto' }
  }
  return format === 'responses' && 'title' in block
    ? { type: 'input_file', filename: block.title, file_data: url }
    : null
}

type OpenAIToolCallParam = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

type OpenAIItem =
  | {
      role: MessageParam['role'] | 'tool'
      content: string | null | NonNullable<ReturnType<typeof userPart>>[]
      tool_calls?: OpenAIToolCallParam[]
      reasoning_content?: string
      tool_call_id?: string
    }
  | {
      type: 'function_call'
      call_id: string
      name: string
      arguments: string
    }
  | {
      type: 'function_call_output'
      call_id: string
      output: string
    }

export const openAIRequest = (
  format: OpenAIFormat,
  body: CreateMessageRequest,
  deepSeek: boolean
) => {
  let pendingReminder: string | undefined
  const messages = body.messages.flatMap<OpenAIItem>(({ role, content }) => {
    if (role === 'latest_reminder') {
      if (deepSeek) {
        return format === 'chat' && !isLocalDateReminder(content) ? [{ role, content }] : []
      }
      pendingReminder = content
      return []
    }
    if (typeof content === 'string') {
      if (role === 'user' && pendingReminder) {
        const merged = prependReminderToUserContent(content, pendingReminder)
        pendingReminder = undefined
        return [{ role, content: merged }]
      }
      pendingReminder = undefined
      return [{ role, content }]
    }
    if (role === 'assistant') {
      pendingReminder = undefined
      const text = content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('')
      const reasoning = content
        .flatMap((block) => (block.type === 'thinking' ? [block.thinking] : []))
        .join('')
      const toolUseBlocks = content.filter(
        (block): block is ClientToolUseBlockParam => block.type === 'tool_use'
      )
      if (toolUseBlocks.length > 0) {
        if (format === 'chat') {
          return [
            {
              role: 'assistant',
              content: text || null,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              tool_calls: toolUseBlocks.map((block) => ({
                id: block.id,
                type: 'function',
                function: {
                  name: block.name,
                  arguments: JSON.stringify(block.input ?? {}),
                },
              })),
            },
          ]
        }
        return [
          ...(text ? [{ role: 'assistant' as const, content: text }] : []),
          ...toolUseBlocks.map((block) => ({
            type: 'function_call' as const,
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          })),
        ]
      }
      return text ? [{ role: 'assistant', content: text }] : []
    }

    const toolResults = content.filter(
      (block): block is ToolResultBlockParam => block.type === 'tool_result'
    )
    const regularBlocks = content.filter(
      (block): block is RegularUserBlock => block.type !== 'tool_result'
    )
    const mergedRegularBlocks =
      pendingReminder && regularBlocks.length > 0
        ? (prependReminderToUserContent(regularBlocks, pendingReminder) as RegularUserBlock[])
        : regularBlocks
    if (pendingReminder && regularBlocks.length > 0) {
      pendingReminder = undefined
    }
    const parts = mergedRegularBlocks
      .map((block) => userPart(format, block, deepSeek))
      .filter((part): part is NonNullable<ReturnType<typeof userPart>> => part !== null)

    const items: OpenAIItem[] = []
    if (toolResults.length > 0) {
      if (format === 'chat') {
        for (const result of toolResults) {
          items.push({
            role: 'tool',
            tool_call_id: result.tool_use_id,
            content: result.content,
          })
        }
      } else {
        for (const result of toolResults) {
          items.push({
            type: 'function_call_output',
            call_id: result.tool_use_id,
            output: result.content,
          })
        }
      }
    }
    if (parts.length > 0) {
      items.push({ role: 'user', content: parts })
    }
    return items
  })

  const serializedClientTools = body.clientTools?.length
    ? format === 'chat'
      ? body.clientTools.map((tool) => ({
          type: 'function' as const,
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        }))
      : body.clientTools.map((tool) => ({
          type: 'function' as const,
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        }))
    : undefined

  const common = {
    model: body.model,
    stream: true,
    ...(deepSeek
      ? {
          safety_check: body.safety_check,
          title: body.title,
          tools: serializedClientTools ?? body.tools?.map(({ type }) => ({ type })),
        }
      : serializedClientTools
        ? { tools: serializedClientTools }
        : {}),
  }
  const thinkingEnabled = body.thinking.type === 'enabled'
  const customEffort =
    body.reasoningEffort && body.reasoningEffort !== 'auto' ? body.reasoningEffort : 'medium'
  const deepSeekResponsesEffort =
    body.reasoningEffort && body.reasoningEffort !== 'auto' ? body.reasoningEffort : 'high'

  if (format === 'chat') {
    return {
      ...common,
      messages: body.system ? [{ role: 'system', content: body.system }, ...messages] : messages,
      ...(deepSeek
        ? { max_tokens: body.max_tokens, thinking: body.thinking }
        : {
            max_completion_tokens: body.max_tokens,
            ...(thinkingEnabled ? { reasoning_effort: customEffort } : {}),
          }),
    }
  }
  return {
    ...common,
    input: messages,
    instructions: body.system || undefined,
    max_output_tokens: body.max_tokens,
    ...(deepSeek
      ? {
          reasoning: {
            effort: thinkingEnabled ? deepSeekResponsesEffort : 'none',
          },
        }
      : thinkingEnabled
        ? {
            reasoning: {
              effort: customEffort,
              summary: 'auto',
            },
          }
        : {}),
    store: false,
  }
}

export type OpenAIToolCallDelta = {
  key: string
  id?: string
  name?: string
  argumentsDelta?: string
  finalArguments?: string
  done?: boolean
}

export type OpenAIFrame = {
  text?: string
  thinking?: string
  toolCalls?: OpenAIToolCallDelta[]
  stop?: StopReason
  done?: boolean
  usage?: MessageUsage
  title?: string
  error?: { message: string; code?: string }
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const asString = (value: unknown) => (typeof value === 'string' ? value : undefined)

const openAIUsage = (value: unknown, format: OpenAIFormat): MessageUsage | undefined => {
  const usage = record(value)
  const input = format === 'chat' ? usage.prompt_tokens : usage.input_tokens
  const output = format === 'chat' ? usage.completion_tokens : usage.output_tokens
  const details = format === 'chat' ? usage.prompt_tokens_details : usage.input_tokens_details
  const cached = record(details).cached_tokens
  if (typeof input !== 'number' || typeof output !== 'number') {
    return
  }
  const cache = typeof cached === 'number' ? cached : 0
  return {
    input_tokens: Math.max(0, input - cache),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cache,
    output_tokens: output,
  }
}

const stopReasons: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

const readChatChunk = (payload: Record<string, unknown>): OpenAIFrame => {
  const choice = record(Array.isArray(payload.choices) ? payload.choices[0] : null)
  const delta = record(choice.delta)
  const finish = asString(choice.finish_reason)
  const rawToolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : null
  const toolCalls: OpenAIToolCallDelta[] = []
  if (rawToolCalls) {
    for (let i = 0; i < rawToolCalls.length; i++) {
      const tc = record(rawToolCalls[i])
      const idx =
        typeof tc.index === 'number' && Number.isSafeInteger(tc.index) && tc.index >= 0
          ? tc.index
          : i
      const fn = record(tc.function)
      const id = asString(tc.id)
      const name = asString(fn.name)
      const argumentsDelta = asString(fn.arguments)
      if (id || name || argumentsDelta !== undefined) {
        toolCalls.push({
          key: `chat:${idx}`,
          id,
          name,
          argumentsDelta,
        })
      }
    }
  }
  return {
    text: asString(delta.content) ?? asString(delta.refusal),
    thinking: asString(delta.reasoning_content) ?? asString(delta.reasoning),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stop: finish && Object.hasOwn(stopReasons, finish) ? stopReasons[finish] : undefined,
    usage: openAIUsage(payload.usage, 'chat'),
    title: asString(delta.title),
  }
}

const readResponseEvent = (payload: Record<string, unknown>): OpenAIFrame => {
  const response = record(payload.response)
  switch (payload.type) {
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return { text: asString(payload.delta) }
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta':
      return { thinking: asString(payload.delta) }
    case 'response.output_item.added': {
      const item = record(payload.item)
      if (item.type !== 'function_call') {
        return {}
      }
      const outputIndex =
        typeof payload.output_index === 'number' && Number.isSafeInteger(payload.output_index)
          ? payload.output_index
          : 0
      const key = asString(item.id) ?? `resp:${outputIndex}`
      const id = asString(item.call_id) ?? asString(item.id) ?? key
      const name = asString(item.name)
      const initialArgs = asString(item.arguments)
      return {
        toolCalls: [
          {
            key,
            id,
            name,
            ...(initialArgs ? { argumentsDelta: initialArgs } : {}),
          },
        ],
      }
    }
    case 'response.function_call_arguments.delta': {
      const outputIndex =
        typeof payload.output_index === 'number' && Number.isSafeInteger(payload.output_index)
          ? payload.output_index
          : 0
      const key = asString(payload.item_id) ?? `resp:${outputIndex}`
      const delta = asString(payload.delta)
      return delta ? { toolCalls: [{ key, argumentsDelta: delta }] } : {}
    }
    case 'response.output_item.done': {
      const item = record(payload.item)
      if (item.type !== 'function_call') {
        return {}
      }
      const outputIndex =
        typeof payload.output_index === 'number' && Number.isSafeInteger(payload.output_index)
          ? payload.output_index
          : 0
      const key = asString(item.id) ?? `resp:${outputIndex}`
      const id = asString(item.call_id) ?? asString(item.id) ?? key
      const name = asString(item.name)
      const finalArguments = asString(item.arguments)
      return {
        toolCalls: [
          {
            key,
            id,
            name,
            ...(finalArguments !== undefined ? { finalArguments } : {}),
            done: true,
          },
        ],
      }
    }
    case 'response.completed': {
      const hasFunctionCall =
        Array.isArray(response.output) &&
        response.output.some((item) => record(item).type === 'function_call')
      return {
        done: true,
        stop: hasFunctionCall ? 'tool_use' : 'end_turn',
        usage: openAIUsage(response.usage, 'responses'),
        title: asString(response.title),
      }
    }
    case 'response.incomplete': {
      const reason = record(response.incomplete_details).reason
      return {
        done: true,
        stop: reason === 'content_filter' ? 'refusal' : 'max_tokens',
        usage: openAIUsage(response.usage, 'responses'),
        title: asString(response.title),
      }
    }
    case 'response.failed':
    case 'error': {
      const error = payload.type === 'error' ? payload : record(response.error)
      return {
        error: { message: asString(error.message) ?? '', code: asString(error.code) },
      }
    }
    default:
      return {}
  }
}

export const readOpenAIFrame = (format: OpenAIFormat, payload: unknown): OpenAIFrame =>
  format === 'chat' ? readChatChunk(record(payload)) : readResponseEvent(record(payload))

type ToolCallState = {
  id: string
  name: string
  pendingArgs: string
  receivedDelta: boolean
  started: boolean
  stopped: boolean
  blockIndex: number
}

export const createOpenAIStreamAdapter = () => {
  let block: 'text' | 'thinking' | undefined
  let index = -1
  let stop: StopReason | undefined
  let usage: MessageUsage | undefined
  let title: string | undefined
  let sawToolCall = false
  const toolStates = new Map<string, ToolCallState>()

  const closeTextOrThinking = (events: MessageStreamEvent[]) => {
    if (block) {
      events.push({ type: 'content_block_stop', index })
      block = undefined
    }
  }

  const ensureToolStarted = (entry: ToolCallState, events: MessageStreamEvent[]) => {
    if (entry.started || !entry.name) {
      return
    }
    closeTextOrThinking(events)
    index += 1
    entry.blockIndex = index
    entry.started = true
    events.push({
      type: 'content_block_start',
      index: entry.blockIndex,
      content_block: {
        type: 'tool_use',
        id: entry.id || `call_${entry.blockIndex}`,
        name: entry.name,
        input: {},
      },
    })
    if (entry.pendingArgs) {
      events.push({
        type: 'content_block_delta',
        index: entry.blockIndex,
        delta: { type: 'input_json_delta', partial_json: entry.pendingArgs },
      })
      entry.pendingArgs = ''
      entry.receivedDelta = true
    }
  }

  const push = (frame: OpenAIFrame): MessageStreamEvent[] => {
    const events: MessageStreamEvent[] = []
    const deltas = [
      ['thinking', frame.thinking],
      ['text', frame.text],
    ] as const
    for (const [type, delta] of deltas) {
      if (!delta) {
        continue
      }
      if (block !== type) {
        closeTextOrThinking(events)
        block = type
        index += 1
        events.push({
          type: 'content_block_start',
          index,
          content_block:
            type === 'text' ? { type, text: '' } : { type, thinking: '', signature: '' },
        })
      }
      events.push({
        type: 'content_block_delta',
        index,
        delta:
          type === 'text'
            ? { type: 'text_delta', text: delta }
            : { type: 'thinking_delta', thinking: delta },
      })
    }

    if (frame.toolCalls?.length) {
      sawToolCall = true
      for (const tc of frame.toolCalls) {
        let entry = toolStates.get(tc.key)
        if (!entry) {
          entry = {
            id: '',
            name: '',
            pendingArgs: '',
            receivedDelta: false,
            started: false,
            stopped: false,
            blockIndex: -1,
          }
          toolStates.set(tc.key, entry)
        }
        if (tc.id && !entry.id) {
          entry.id = tc.id
        }
        if (tc.name && !entry.name) {
          entry.name = tc.name
        }
        ensureToolStarted(entry, events)
        if (tc.argumentsDelta) {
          if (entry.started) {
            events.push({
              type: 'content_block_delta',
              index: entry.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.argumentsDelta },
            })
            entry.receivedDelta = true
          } else {
            entry.pendingArgs += tc.argumentsDelta
          }
        }
        if (tc.done) {
          if (!entry.started) {
            ensureToolStarted(entry, events)
          }
          if (entry.started && !entry.receivedDelta && tc.finalArguments) {
            events.push({
              type: 'content_block_delta',
              index: entry.blockIndex,
              delta: { type: 'input_json_delta', partial_json: tc.finalArguments },
            })
            entry.receivedDelta = true
          }
          if (entry.started && !entry.stopped) {
            events.push({ type: 'content_block_stop', index: entry.blockIndex })
            entry.stopped = true
          }
        }
      }
    }

    stop = frame.stop ?? stop
    usage = frame.usage ?? usage
    title = frame.title ?? title
    return events
  }

  const finish = (): MessageStreamEvent[] => {
    const events: MessageStreamEvent[] = []
    closeTextOrThinking(events)
    for (const entry of toolStates.values()) {
      ensureToolStarted(entry, events)
      if (entry.started && !entry.stopped) {
        events.push({ type: 'content_block_stop', index: entry.blockIndex })
        entry.stopped = true
      }
    }
    const finalStop: StopReason =
      sawToolCall && (!stop || stop === 'end_turn') ? 'tool_use' : (stop ?? 'end_turn')
    events.push({
      type: 'message_delta',
      delta: { stop_reason: finalStop, stop_sequence: null, title },
      usage,
    })
    events.push({ type: 'message_stop' })
    return events
  }

  return {
    push,
    finish,
    hasOutput: () => index >= 0,
    getStop: () => stop,
  }
}
