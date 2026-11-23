import type {
  AssistantBlockParam,
  ClientToolUseBlockParam,
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
  ToolResultBlockParam,
} from '../../services/api/types.js'
import { applyEvent } from '../../services/chat/reply.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { LOOP_ABORT_TOOL_RESULT } from './builtin.js'
import {
  canonicalStableJson,
  createToolRegistry,
  type BeforeToolExecuteHook,
} from './registry.js'
import type {
  ClientToolCallBlock,
  ClientToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types.js'

export type ClientToolLoopOptions = {
  baseBody: CreateMessageRequest
  tools: readonly ClientToolDefinition[]
  toolContext: ToolExecutionContext
  initialReply: AssistantMessage
  streamStep: (
    body: CreateMessageRequest,
    signal: AbortSignal
  ) => AsyncIterable<MessageStreamEvent>
  onReplyUpdate: (reply: AssistantMessage, immediate?: boolean) => void
  onContentReceived?: () => void
  onTitle?: (title: string) => void
  beforeExecute?: BeforeToolExecuteHook
  signal: AbortSignal
  now?: () => number
}

export type ClientToolLoopResult = {
  reply: AssistantMessage
  receivedContent: boolean
}

type CollectedBlock =
  | { kind: 'thinking'; thinking: string; signature: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool_use'; id: string; name: string; initialInput: unknown; jsonBuffer: string }

type ParsedToolCall = {
  id: string
  name: string
  input: Record<string, unknown>
  rawInput?: string
  parseError?: string
  signature: string
}

export const TOOL_DENIED_RESULT =
  'Tool call denied by the user. Do not retry this tool call. Continue responding to the user without executing this action, or briefly ask if they want an alternative approach.'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeUsage = (
  usage: MessageUsage,
  priorOutputTokens: number
): MessageUsage => ({
  input_tokens: usage.input_tokens,
  cache_creation_input_tokens: usage.cache_creation_input_tokens,
  cache_read_input_tokens: usage.cache_read_input_tokens,
  output_tokens: priorOutputTokens + usage.output_tokens,
  ...(usage.server_tool_use ? { server_tool_use: usage.server_tool_use } : {}),
})

const parseToolCall = (block: Extract<CollectedBlock, { kind: 'tool_use' }>): ParsedToolCall => {
  const raw = block.jsonBuffer.trim()
  let input: Record<string, unknown> = {}
  let rawInput: string | undefined
  let parseError: string | undefined

  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (isPlainObject(parsed)) {
        input = parsed
      } else {
        rawInput = block.jsonBuffer
        parseError = 'Invalid JSON arguments: expected a JSON object.'
      }
    } catch {
      rawInput = block.jsonBuffer
      parseError = 'Invalid JSON arguments. Please provide a valid JSON object matching the tool schema.'
    }
  } else if (isPlainObject(block.initialInput)) {
    input = block.initialInput
  }

  return {
    id: block.id,
    name: block.name,
    input,
    rawInput,
    parseError,
    signature: `${block.name}:${parseError ? rawInput ?? '' : canonicalStableJson(input)}`,
  }
}

const buildAssistantStepMessage = (
  collected: Iterable<CollectedBlock>,
  parsedCallsById: ReadonlyMap<string, ParsedToolCall>
): MessageParam => {
  const content: AssistantBlockParam[] = []
  for (const block of collected) {
    if (block.kind === 'thinking' && block.thinking) {
      content.push({
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      })
    } else if (block.kind === 'text' && block.text) {
      content.push({ type: 'text', text: block.text })
    } else if (block.kind === 'tool_use') {
      const parsed = parsedCallsById.get(block.id)
      const toolParam: ClientToolUseBlockParam = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: parsed?.input ?? {},
      }
      content.push(toolParam)
    }
  }
  return { role: 'assistant', content }
}

const updateToolBlock = (
  reply: AssistantMessage,
  toolCallId: string,
  updater: (block: ClientToolCallBlock) => ClientToolCallBlock
): AssistantMessage => ({
  ...reply,
  blocks: reply.blocks.map((block) =>
    block.type === 'client_tool_call' && block.id === toolCallId ? updater(block) : block
  ),
})

export const runClientToolLoop = async ({
  baseBody,
  tools,
  toolContext,
  initialReply,
  streamStep,
  onReplyUpdate,
  onContentReceived,
  onTitle,
  beforeExecute,
  signal,
  now = Date.now,
}: ClientToolLoopOptions): Promise<ClientToolLoopResult> => {
  const registry = createToolRegistry(tools)
  const toolSchemas = registry.toSchemas()
  const turnMessages: MessageParam[] = [...baseBody.messages]

  let reply = initialReply
  let receivedContent = false
  let accumulatedOutputTokens = 0
  let lastInputSnapshot: Pick<
    MessageUsage,
    'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'
  > | null = null

  let lastSingleSignature = ''
  let singleSignatureStreak = 0
  let lastStepSignature = ''
  let stepSignatureStreak = 0
  let consecutiveErrorSteps = 0
  let forceFinalWithoutTools = false

  for (;;) {
    signal.throwIfAborted()

    const stepBody: CreateMessageRequest = {
      ...baseBody,
      messages: turnMessages,
      tools: undefined,
      clientTools: forceFinalWithoutTools || toolSchemas.length === 0 ? undefined : toolSchemas,
    }

    const stepBlocks = new Map<number, CollectedBlock>()
    const blockIndexes = new Map<number, number>()
    let stepUsage: MessageUsage | undefined
    let stepStopReason: StopReason | undefined

    for await (const event of streamStep(stepBody, signal)) {
      if (event.type === 'content_block_start') {
        receivedContent = true
        onContentReceived?.()
        const block = event.content_block
        if (block.type === 'thinking') {
          stepBlocks.set(event.index, {
            kind: 'thinking',
            thinking: block.thinking,
            signature: block.signature ?? '',
          })
        } else if (block.type === 'text') {
          stepBlocks.set(event.index, { kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          stepBlocks.set(event.index, {
            kind: 'tool_use',
            id: block.id,
            name: block.name,
            initialInput: block.input,
            jsonBuffer: '',
          })
        }
      } else if (event.type === 'content_block_delta') {
        const entry = stepBlocks.get(event.index)
        if (entry) {
          if (entry.kind === 'thinking' && event.delta.type === 'thinking_delta') {
            entry.thinking += event.delta.thinking
          } else if (entry.kind === 'thinking' && event.delta.type === 'signature_delta') {
            entry.signature += event.delta.signature
          } else if (entry.kind === 'text' && event.delta.type === 'text_delta') {
            entry.text += event.delta.text
          } else if (entry.kind === 'tool_use' && event.delta.type === 'input_json_delta') {
            entry.jsonBuffer += event.delta.partial_json
          }
        }
      } else if (event.type === 'message_start' && event.message.usage) {
        stepUsage = event.message.usage
      } else if (event.type === 'message_delta') {
        stepStopReason = event.delta.stop_reason
        if (event.usage) {
          stepUsage = event.usage
        }
        if (
          (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
          event.delta.title?.trim()
        ) {
          onTitle?.(event.delta.title.trim())
        }
      }

      reply = applyEvent(reply, event, now(), blockIndexes)
      if (stepUsage) {
        reply = { ...reply, usage: mergeUsage(stepUsage, accumulatedOutputTokens) }
      }
      onReplyUpdate(reply, false)
    }

    if (stepUsage) {
      accumulatedOutputTokens += stepUsage.output_tokens
      lastInputSnapshot = {
        input_tokens: stepUsage.input_tokens,
        cache_creation_input_tokens: stepUsage.cache_creation_input_tokens,
        cache_read_input_tokens: stepUsage.cache_read_input_tokens,
      }
      reply = {
        ...reply,
        usage: { ...lastInputSnapshot, output_tokens: accumulatedOutputTokens },
      }
      onReplyUpdate(reply, true)
    } else if (lastInputSnapshot) {
      reply = {
        ...reply,
        usage: { ...lastInputSnapshot, output_tokens: accumulatedOutputTokens },
      }
      onReplyUpdate(reply, true)
    }

    const rawToolCalls = Array.from(stepBlocks.values()).filter(
      (block): block is Extract<CollectedBlock, { kind: 'tool_use' }> => block.kind === 'tool_use'
    )

    if (forceFinalWithoutTools || stepStopReason !== 'tool_use' || rawToolCalls.length === 0) {
      return { reply, receivedContent }
    }

    const parsedCalls = rawToolCalls.map(parseToolCall)
    const parsedById = new Map(parsedCalls.map((call) => [call.id, call]))
    const assistantStepMsg = buildAssistantStepMessage(stepBlocks.values(), parsedById)

    let repeatLoopDetected = false
    for (const call of parsedCalls) {
      if (call.signature === lastSingleSignature) {
        singleSignatureStreak += 1
      } else {
        lastSingleSignature = call.signature
        singleSignatureStreak = 1
      }
      if (singleSignatureStreak >= 3) {
        repeatLoopDetected = true
        break
      }
    }

    const stepSignature = parsedCalls.map((call) => call.signature).join('|')
    if (stepSignature === lastStepSignature) {
      stepSignatureStreak += 1
    } else {
      lastStepSignature = stepSignature
      stepSignatureStreak = 1
    }
    if (stepSignatureStreak >= 3) {
      repeatLoopDetected = true
    }

    if (repeatLoopDetected) {
      const timestamp = now()
      const abortBlock: ClientToolCallBlock = {
        type: 'client_tool_call',
        id: `loop-abort-${parsedCalls[0].id}`,
        name: parsedCalls[0].name,
        source: registry.get(parsedCalls[0].name)?.source ?? 'builtin',
        input: parsedCalls[0].input,
        status: 'aborted_loop',
        startedAt: timestamp,
        endedAt: timestamp,
      }
      reply = { ...reply, blocks: [...reply.blocks, abortBlock] }
      onReplyUpdate(reply, true)

      const abortResults: ToolResultBlockParam[] = parsedCalls.map((call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: LOOP_ABORT_TOOL_RESULT,
        is_error: true,
      }))
      turnMessages.push(assistantStepMsg, { role: 'user', content: abortResults })
      forceFinalWithoutTools = true
      continue
    }

    const stepStart = now()
    const runningBlocks: ClientToolCallBlock[] = parsedCalls.map((call) => {
      const def = registry.get(call.name)
      return {
        type: 'client_tool_call',
        id: call.id,
        name: call.name,
        ...(def?.displayName ? { displayName: def.displayName } : {}),
        source: def?.source ?? 'builtin',
        ...(def?.serverId ? { serverId: def.serverId } : {}),
        ...(def?.serverName ? { serverName: def.serverName } : {}),
        input: call.input,
        ...(call.rawInput !== undefined ? { rawInput: call.rawInput } : {}),
        status: 'running',
        startedAt: stepStart,
      }
    })
    reply = { ...reply, blocks: [...reply.blocks, ...runningBlocks] }
    onReplyUpdate(reply, true)

    const executedResults = await Promise.all(
      parsedCalls.map(async (call): Promise<ToolExecutionResult> => {
        let result: ToolExecutionResult
        let deniedByUser = false
        if (call.parseError) {
          result = { content: call.parseError, isError: true }
        } else {
          const tool = registry.get(call.name)
          if (!tool) {
            result = { content: `Unknown tool: ${call.name}`, isError: true }
          } else {
            const setStatus = (nextStatus: 'awaiting_confirmation' | 'running') => {
              if (signal.aborted) {
                return
              }
              reply = updateToolBlock(reply, call.id, (block) => ({
                ...block,
                status: nextStatus,
                ...(nextStatus === 'running' ? { startedAt: now() } : {}),
              }))
              onReplyUpdate(reply, true)
            }
            const decision = beforeExecute
              ? await beforeExecute(
                  { id: call.id, name: call.name, tool, input: call.input },
                  { setStatus }
                )
              : 'allow'
            if (decision === 'deny') {
              deniedByUser = true
              result = { content: TOOL_DENIED_RESULT, isError: true }
            } else {
              setStatus('running')
              try {
                result = await tool.execute(call.input, toolContext)
              } catch (error) {
                if (signal.aborted) {
                  throw error
                }
                result = {
                  content: `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`,
                  isError: true,
                }
              }
            }
          }
        }

        const endedAt = now()
        if (!signal.aborted) {
          reply = updateToolBlock(reply, call.id, (block) => ({
            ...block,
            status: deniedByUser ? 'denied' : result.isError ? 'error' : 'done',
            output: result.content,
            ...(result.isError ? { error: result.content } : { error: undefined }),
            ...(result.meta ? { meta: result.meta } : {}),
            endedAt,
          }))
          onReplyUpdate(reply, true)
        }
        return result
      })
    )

    signal.throwIfAborted()

    const allFailed = executedResults.every((item) => Boolean(item.isError))
    if (allFailed) {
      consecutiveErrorSteps += 1
    } else {
      consecutiveErrorSteps = 0
    }

    if (consecutiveErrorSteps >= 3) {
      const timestamp = now()
      const abortBlock: ClientToolCallBlock = {
        type: 'client_tool_call',
        id: `loop-abort-err-${parsedCalls[0].id}`,
        name: parsedCalls[0].name,
        source: registry.get(parsedCalls[0].name)?.source ?? 'builtin',
        input: parsedCalls[0].input,
        status: 'aborted_loop',
        startedAt: timestamp,
        endedAt: timestamp,
      }
      reply = { ...reply, blocks: [...reply.blocks, abortBlock] }
      onReplyUpdate(reply, true)

      const abortResults: ToolResultBlockParam[] = parsedCalls.map((call) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: LOOP_ABORT_TOOL_RESULT,
        is_error: true,
      }))
      turnMessages.push(assistantStepMsg, { role: 'user', content: abortResults })
      forceFinalWithoutTools = true
      continue
    }

    const toolResultParams: ToolResultBlockParam[] = parsedCalls.map((call, index) => ({
      type: 'tool_result',
      tool_use_id: call.id,
      content: executedResults[index].content,
      ...(executedResults[index].isError ? { is_error: true } : {}),
    }))
    turnMessages.push(assistantStepMsg, { role: 'user', content: toolResultParams })
  }
}
