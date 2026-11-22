import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildActiveClientTools, LOOP_ABORT_TOOL_RESULT } from '../src/elsewhere/tools/builtin.js'
import { getClientToolsAreaTitle } from '../src/elsewhere/tools/timelineTitle.js'
import { runClientToolLoop } from '../src/elsewhere/tools/loop.js'
import type { ClientToolDefinition, SearchToolsRuntimeConfig } from '../src/elsewhere/tools/types.js'
import type { CreateMessageRequest, MessageStreamEvent } from '../src/services/api/types.js'
import { readSessionFile } from '../src/services/chat/history/schema.js'
import { toSessionFile } from '../src/services/chat/history/toArchive.js'
import { toLocalSession } from '../src/services/chat/history/toLocal.js'
import { canContinueReply, settleReply, toRequestMessages } from '../src/services/chat/reply.js'
import type { AssistantMessage, Session, UserMessage } from '../src/services/chat/types.js'
import { buildReplyView } from '../src/services/chat/view.js'

const baseConfig: SearchToolsRuntimeConfig = {
  engine: 'deepseek',
  officialApiKey: 'test-key',
  apiKeys: {},
  searxngUrl: '',
  webFetchMode: 'auto',
  useExternalOnOfficial: false,
}

const makeReply = (): AssistantMessage => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 1000,
  model: 'test-model',
  thinking: false,
  search: true,
  prefix: false,
  status: 'pending',
  blocks: [],
})

const makeBaseBody = (): CreateMessageRequest => ({
  model: 'test-model',
  max_tokens: 2048,
  system: '',
  messages: [{ role: 'user', content: 'Check latest version' }],
  thinking: { type: 'disabled' },
})

async function* emitEvents(events: MessageStreamEvent[]): AsyncGenerator<MessageStreamEvent> {
  for (const event of events) {
    yield event
  }
}

describe('Client tool loop', () => {
  it('executes parallel tool steps, accumulates output_tokens, and keeps latest input snapshot', async () => {
    const requests: CreateMessageRequest[] = []
    const executionOrder: string[] = []
    let nowValue = 1000

    const tools: ClientToolDefinition[] = [
      {
        name: 'tool_a',
        description: 'A',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: async (input) => {
          executionOrder.push(`a:${String(input.q)}`)
          return { content: `result-a-${String(input.q)}` }
        },
      },
      {
        name: 'tool_b',
        description: 'B',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: async (input) => {
          executionOrder.push(`b:${String(input.url)}`)
          return { content: `result-b-${String(input.url)}` }
        },
      },
    ]

    let step = 0
    const controller = new AbortController()
    const result = await runClientToolLoop({
      baseBody: makeBaseBody(),
      tools,
      toolContext: { signal: controller.signal, config: baseConfig },
      initialReply: makeReply(),
      streamStep: (body) => {
        requests.push(body)
        step += 1
        if (step === 1) {
          return emitEvents([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'c1', name: 'tool_a', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"q":"one"}' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'c2', name: 'tool_b', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"url":"https://a.test"}' },
            },
            { type: 'content_block_stop', index: 1 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'tool_use', stop_sequence: null },
              usage: {
                input_tokens: 100,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 20,
                output_tokens: 30,
              },
            },
            { type: 'message_stop' },
          ])
        }
        return emitEvents([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final answer.' } },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: {
              input_tokens: 220,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 40,
              output_tokens: 15,
            },
          },
          { type: 'message_stop' },
        ])
      },
      onReplyUpdate: () => {},
      signal: controller.signal,
      now: () => (nowValue += 100),
    })

    assert.equal(requests.length, 2)
    assert.deepEqual(executionOrder, ['a:one', 'b:https://a.test'])
    assert.equal(result.reply.usage?.input_tokens, 220)
    assert.equal(result.reply.usage?.cache_read_input_tokens, 40)
    assert.equal(result.reply.usage?.output_tokens, 45)
    assert.equal(result.reply.blocks.filter((b) => b.type === 'client_tool_call').length, 2)
    assert.equal(result.reply.blocks.find((b) => b.type === 'text')?.text, 'Final answer.')
  })

  it('recovers cleanly from invalid JSON args and tool errors without crashing', async () => {
    const sentMessages: CreateMessageRequest['messages'][] = []
    const tools: ClientToolDefinition[] = [
      {
        name: 'flaky_tool',
        description: 'Flaky',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: async () => {
          throw new Error('Upstream timeout')
        },
      },
    ]

    let step = 0
    const controller = new AbortController()
    const result = await runClientToolLoop({
      baseBody: makeBaseBody(),
      tools,
      toolContext: { signal: controller.signal, config: baseConfig },
      initialReply: makeReply(),
      streamStep: (body) => {
        sentMessages.push(body.messages)
        step += 1
        if (step === 1) {
          return emitEvents([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'bad_json', name: 'flaky_tool', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{broken' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'content_block_start',
              index: 1,
              content_block: { type: 'tool_use', id: 'throws_err', name: 'flaky_tool', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: '{"q":"ok"}' },
            },
            { type: 'content_block_stop', index: 1 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
            { type: 'message_stop' },
          ])
        }
        return emitEvents([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Handled.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
          { type: 'message_stop' },
        ])
      },
      onReplyUpdate: () => {},
      signal: controller.signal,
    })

    const toolBlocks = result.reply.blocks.filter((b) => b.type === 'client_tool_call')
    assert.equal(toolBlocks.length, 2)
    assert.equal(toolBlocks[0].status, 'error')
    assert.equal(toolBlocks[1].status, 'error')
    assert.match(toolBlocks[1].error ?? '', /Upstream timeout/)

    const step2UserMsg = sentMessages[1][2]
    assert.equal(step2UserMsg.role, 'user')
    assert.ok(Array.isArray(step2UserMsg.content))
    assert.equal(step2UserMsg.content[0].type, 'tool_result')
    assert.equal(step2UserMsg.content[0].is_error, true)
    assert.equal(step2UserMsg.content[1].type, 'tool_result')
    assert.equal(step2UserMsg.content[1].is_error, true)
  })

  it('triggers circuit breaker on 3rd consecutive identical signature and forces tool-less wrap-up', async () => {
    let execCount = 0
    const sentRequests: CreateMessageRequest[] = []
    const tools: ClientToolDefinition[] = [
      {
        name: 'web_search',
        description: 'Search',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: async () => {
          execCount += 1
          return { content: 'empty' }
        },
      },
    ]

    let step = 0
    const controller = new AbortController()
    const result = await runClientToolLoop({
      baseBody: makeBaseBody(),
      tools,
      toolContext: { signal: controller.signal, config: baseConfig },
      initialReply: makeReply(),
      streamStep: (body) => {
        sentRequests.push(body)
        step += 1
        if (step <= 3) {
          // Keys intentionally reordered on step 2 & 3 to verify canonicalStableJson matching.
          const json =
            step === 1
              ? '{"query":"same","count":6}'
              : step === 2
                ? '{"count":6,"query":"same"}'
                : '{"query":"same","count":6}'
          return emitEvents([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: `call_${step}`, name: 'web_search', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: json },
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
            { type: 'message_stop' },
          ])
        }
        return emitEvents([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Stopped loop.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
          { type: 'message_stop' },
        ])
      },
      onReplyUpdate: () => {},
      signal: controller.signal,
    })

    assert.equal(execCount, 2)
    assert.equal(sentRequests.length, 4)
    assert.equal(sentRequests[3].clientTools, undefined)

    const abortedBlock = result.reply.blocks.find(
      (b) => b.type === 'client_tool_call' && b.status === 'aborted_loop'
    )
    assert.ok(abortedBlock)

    const lastToolResultMsg = sentRequests[3].messages.at(-1)
    assert.ok(lastToolResultMsg && lastToolResultMsg.role === 'user' && Array.isArray(lastToolResultMsg.content))
    assert.deepEqual(lastToolResultMsg.content[0], {
      type: 'tool_result',
      tool_use_id: 'call_3',
      content: LOOP_ABORT_TOOL_RESULT,
      is_error: true,
    })
  })

  it('triggers circuit breaker after 3 consecutive all-error steps', async () => {
    const sentRequests: CreateMessageRequest[] = []
    const tools: ClientToolDefinition[] = [
      {
        name: 'web_fetch',
        description: 'Fetch',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: async (input) => ({ content: `403 on ${String(input.url)}`, isError: true }),
      },
    ]

    let step = 0
    const controller = new AbortController()
    const result = await runClientToolLoop({
      baseBody: makeBaseBody(),
      tools,
      toolContext: { signal: controller.signal, config: baseConfig },
      initialReply: makeReply(),
      streamStep: (body) => {
        sentRequests.push(body)
        step += 1
        if (step <= 3) {
          return emitEvents([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: `err_${step}`, name: 'web_fetch', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify({ url: `https://example.com/${step}` }),
              },
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
            { type: 'message_stop' },
          ])
        }
        return emitEvents([
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Could not verify.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
          { type: 'message_stop' },
        ])
      },
      onReplyUpdate: () => {},
      signal: controller.signal,
    })

    assert.equal(sentRequests.length, 4)
    assert.equal(sentRequests[3].clientTools, undefined)
    assert.ok(
      result.reply.blocks.some((b) => b.type === 'client_tool_call' && b.status === 'aborted_loop')
    )
  })

  it('aborts running tools immediately on AbortSignal and settles running blocks as stopped', async () => {
    const controller = new AbortController()
    let latestReply = makeReply()
    let toolSignalAborted = false

    const tools: ClientToolDefinition[] = [
      {
        name: 'slow_tool',
        description: 'Slow',
        inputSchema: { type: 'object' },
        source: 'builtin',
        readOnly: true,
        execute: (_input, ctx) =>
          new Promise((_, reject) => {
            ctx.signal.addEventListener(
              'abort',
              () => {
                toolSignalAborted = true
                reject(ctx.signal.reason)
              },
              { once: true }
            )
            controller.abort()
          }),
      },
    ]

    await assert.rejects(
      runClientToolLoop({
        baseBody: makeBaseBody(),
        tools,
        toolContext: { signal: controller.signal, config: baseConfig },
        initialReply: latestReply,
        streamStep: () =>
          emitEvents([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'slow_1', name: 'slow_tool', input: {} },
            },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null } },
            { type: 'message_stop' },
          ]),
        onReplyUpdate: (next) => {
          latestReply = next
        },
        signal: controller.signal,
      })
    )

    assert.equal(toolSignalAborted, true)
    const settled = settleReply(latestReply, 'stopped', 5000)
    const toolBlock = settled.blocks.find((b) => b.type === 'client_tool_call')
    assert.ok(toolBlock && toolBlock.type === 'client_tool_call')
    assert.equal(toolBlock.status, 'stopped')
    assert.equal(toolBlock.endedAt, 5000)
  })

  it('disables continuation and omits client_tool_call in cross-turn history', () => {
    const u1: UserMessage = { id: 'u1', role: 'user', content: 'Hi', files: [], createdAt: 100 }
    const a1: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      createdAt: 200,
      model: 'test-model',
      prefix: true,
      status: 'stopped',
      blocks: [
        {
          type: 'client_tool_call',
          id: 'tc1',
          name: 'web_search',
          source: 'builtin',
          input: { query: 'test' },
          status: 'done',
          output: 'huge search payload',
          startedAt: 201,
          endedAt: 250,
        },
        { type: 'text', text: 'Here is the answer.' },
      ],
    }
    const u2: UserMessage = { id: 'u2', role: 'user', content: 'Next?', files: [], createdAt: 300 }

    assert.equal(canContinueReply(a1), false)

    const params = toRequestMessages([u1, a1], u2)
    assert.deepEqual(params, [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Here is the answer.' }] },
      { role: 'user', content: 'Next?' },
    ])
  })

  it('builds ReplyView sources with deduplication, fetched flag, and timeline titles, and round-trips archive safely', () => {
    const reply: AssistantMessage = {
      id: 'a-view',
      role: 'assistant',
      createdAt: 1000,
      model: 'test-model',
      thinking: true,
      search: true,
      prefix: false,
      status: 'done',
      blocks: [
        { type: 'thinking', thinking: 'Let me check', startedAt: 1000, endedAt: 3000 },
        {
          type: 'client_tool_call',
          id: 's1',
          name: 'web_search',
          source: 'builtin',
          input: { query: 'hello' },
          status: 'done',
          output: 'ok',
          startedAt: 3000,
          endedAt: 5000,
          meta: {
            kind: 'search',
            engine: 'tavily',
            queries: ['hello'],
            results: [
              { title: 'One', url: 'https://one.test/a', snippet: 'first' },
              { title: 'Two', url: 'https://two.test/b', snippet: 'second' },
            ],
          },
        },
        {
          type: 'client_tool_call',
          id: 'f1',
          name: 'web_fetch',
          source: 'builtin',
          input: { url: 'https://one.test/a' },
          status: 'done',
          output: 'body',
          startedAt: 5000,
          endedAt: 7000,
          meta: {
            kind: 'fetch',
            url: 'https://one.test/a',
            title: 'One Full',
            truncated: false,
            charCount: 100,
          },
        },
        { type: 'text', text: 'Answer text.' },
      ],
    }

    const view = buildReplyView(reply, false)
    assert.equal(view.searchResults.length, 2)
    assert.equal(view.searchResults[0].url, 'https://one.test/a')
    assert.equal(view.searchResults[0].fetched, true)
    assert.equal(view.searchResults[1].fetched, undefined)

    const title = getClientToolsAreaTitle(view, false, 8000, true, true)
    assert.equal(title, '已思考与检索（用时 6 秒 · 2 步）')

    const session: Session = {
      id: 'sess-1',
      title: 'Test',
      createdAt: 1000,
      updatedAt: 8000,
      rootMessageId: 'u1',
      messages: [
        { id: 'u1', role: 'user', content: 'Hi', files: [], createdAt: 900, parentId: null, selectedChildId: 'a-view' },
        { ...reply, parentId: 'u1' },
      ],
    }
    const archived = toSessionFile(session, () => null)
    const parsed = readSessionFile(JSON.parse(JSON.stringify(archived)))
    const local = toLocalSession(parsed)
    assert.equal(local.session.messages.length, 2)
    const restoredReply = local.session.messages[1]
    assert.equal(restoredReply.role, 'assistant')
    assert.ok(restoredReply.blocks.some((b) => b.type === 'text' && b.text === 'Answer text.'))
  })

  it('activates web_search and web_fetch according to switch and URL presence', () => {
    const searchOn = buildActiveClientTools({
      searchEnabled: true,
      questionText: 'news?',
      config: baseConfig,
    })
    assert.deepEqual(
      searchOn.map((t) => t.name),
      ['web_search', 'web_fetch']
    )

    const searchOffWithUrl = buildActiveClientTools({
      searchEnabled: false,
      questionText: 'read https://example.com/docs please',
      config: baseConfig,
    })
    assert.deepEqual(
      searchOffWithUrl.map((t) => t.name),
      ['web_fetch']
    )

    const searchOffNoUrl = buildActiveClientTools({
      searchEnabled: false,
      questionText: 'write quicksort',
      config: baseConfig,
    })
    assert.deepEqual(searchOffNoUrl, [])

    const fetchOff = buildActiveClientTools({
      searchEnabled: true,
      questionText: 'https://example.com',
      config: { ...baseConfig, webFetchMode: 'off' },
    })
    assert.deepEqual(
      fetchOff.map((t) => t.name),
      ['web_search']
    )
  })
})
