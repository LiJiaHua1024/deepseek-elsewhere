import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { customMessagesRequest } from '../src/services/api/client.js'
import {
  createOpenAIStreamAdapter,
  openAIRequest,
  readOpenAIFrame,
} from '../src/services/api/openaiChat.js'
import { readMessageEvent } from '../src/services/api/parseEvent.js'
import type { CreateMessageRequest, MessageStreamEvent } from '../src/services/api/types.js'
import { toRequestMessages } from '../src/services/chat/reply.js'
import type { Message, UserMessage } from '../src/services/chat/types.js'

const sampleTools = [
  {
    name: 'web_search',
    description: 'Search the web',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a page',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
]

const sampleRequest: CreateMessageRequest = {
  model: 'test-model',
  max_tokens: 2048,
  system: 'Be helpful.',
  thinking: { type: 'disabled' },
  clientTools: sampleTools,
  messages: [
    { role: 'user', content: 'Check latest release' },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'signed thought', signature: 'sig-123' },
        { type: 'thinking', thinking: 'unsigned thought', signature: '' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'release notes' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'Version 2.0 released',
          is_error: false,
        },
      ],
    },
  ],
}

describe('Anthropic Messages tool calling', () => {
  it('serializes clientTools, signed thinking, tool_use, and tool_result', () => {
    const req = customMessagesRequest(sampleRequest)
    assert.deepEqual(req.tools, [
      {
        name: 'web_search',
        description: 'Search the web',
        input_schema: sampleTools[0].inputSchema,
      },
      {
        name: 'web_fetch',
        description: 'Fetch a page',
        input_schema: sampleTools[1].inputSchema,
      },
    ])
    assert.equal(req.messages.length, 3)
    const assistantMsg = req.messages[1]
    assert.equal(assistantMsg.role, 'assistant')
    assert.deepEqual(assistantMsg.content, [
      { type: 'thinking', thinking: 'signed thought', signature: 'sig-123' },
      { type: 'text', text: 'Let me check.' },
      { type: 'tool_use', id: 'call_1', name: 'web_search', input: { query: 'release notes' } },
    ])
    const toolResultMsg = req.messages[2]
    assert.equal(toolResultMsg.role, 'user')
    assert.deepEqual(toolResultMsg.content, [
      {
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'Version 2.0 released',
        is_error: false,
      },
    ])
  })

  it('parses tool_use start and input_json_delta events', () => {
    const start = readMessageEvent({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'web_search',
        input: {},
      },
    })
    assert.deepEqual(start, {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: {} },
    })

    const delta = readMessageEvent({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":"hi"}' },
    })
    assert.deepEqual(delta, {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query":"hi"}' },
    })
  })
})

describe('OpenAI Chat Completions tool calling', () => {
  it('serializes function tools, tool_calls with reasoning_content, and role:tool results', () => {
    const req = openAIRequest('chat', sampleRequest, false) as {
      tools: unknown[]
      messages: Record<string, unknown>[]
    }
    assert.deepEqual(req.tools, [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web',
          parameters: sampleTools[0].inputSchema,
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: 'Fetch a page',
          parameters: sampleTools[1].inputSchema,
        },
      },
    ])
    assert.equal(req.messages[0].role, 'system')
    assert.equal(req.messages[1].role, 'user')
    assert.deepEqual(req.messages[2], {
      role: 'assistant',
      content: 'Let me check.',
      reasoning_content: 'signed thoughtunsigned thought',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'web_search', arguments: '{"query":"release notes"}' },
        },
      ],
    })
    assert.deepEqual(req.messages[3], {
      role: 'tool',
      tool_call_id: 'call_1',
      content: 'Version 2.0 released',
    })
  })

  it('merges parallel and fragmented delta.tool_calls by index and emits stop_reason tool_use', () => {
    const adapter = createOpenAIStreamAdapter()
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'web_search', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 1, id: 'call_b', type: 'function', function: { name: 'web_fetch', arguments: '{"url":' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"query":"foo"}' } },
                { index: 1, function: { arguments: '"https://example.com"}' } },
              ],
            },
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 100, completion_tokens: 25 },
      },
    ]

    const events: MessageStreamEvent[] = []
    for (const chunk of chunks) {
      events.push(...adapter.push(readOpenAIFrame('chat', chunk)))
    }
    events.push(...adapter.finish())

    const starts = events.filter((e) => e.type === 'content_block_start')
    assert.equal(starts.length, 2)
    assert.deepEqual(starts[0], {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_a', name: 'web_search', input: {} },
    })
    assert.deepEqual(starts[1], {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_b', name: 'web_fetch', input: {} },
    })

    const deltasFor0 = events
      .filter((e) => e.type === 'content_block_delta' && e.index === 0)
      .map((e) => (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta' ? e.delta.partial_json : ''))
      .join('')
    const deltasFor1 = events
      .filter((e) => e.type === 'content_block_delta' && e.index === 1)
      .map((e) => (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta' ? e.delta.partial_json : ''))
      .join('')
    assert.equal(deltasFor0, '{"query":"foo"}')
    assert.equal(deltasFor1, '{"url":"https://example.com"}')

    const msgDelta = events.find((e) => e.type === 'message_delta')
    assert.ok(msgDelta && msgDelta.type === 'message_delta')
    assert.equal(msgDelta.delta.stop_reason, 'tool_use')
    assert.equal(msgDelta.usage?.input_tokens, 100)
    assert.equal(msgDelta.usage?.output_tokens, 25)
  })
})

describe('OpenAI Responses tool calling', () => {
  it('serializes function tools, function_call, and function_call_output', () => {
    const req = openAIRequest('responses', sampleRequest, false) as {
      tools: unknown[]
      input: Record<string, unknown>[]
    }
    assert.deepEqual(req.tools, [
      {
        type: 'function',
        name: 'web_search',
        description: 'Search the web',
        parameters: sampleTools[0].inputSchema,
      },
      {
        type: 'function',
        name: 'web_fetch',
        description: 'Fetch a page',
        parameters: sampleTools[1].inputSchema,
      },
    ])
    assert.deepEqual(req.input, [
      { role: 'user', content: 'Check latest release' },
      { role: 'assistant', content: 'Let me check.' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'web_search',
        arguments: '{"query":"release notes"}',
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: 'Version 2.0 released',
      },
    ])
  })

  it('parses output_item.added + arguments.delta + maps response.completed with function_call to tool_use', () => {
    const adapter = createOpenAIStreamAdapter()
    const packets = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_1', call_id: 'call_resp_1', type: 'function_call', name: 'web_fetch', arguments: '' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta: '{"url":"https://',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'fc_1',
        delta: 'example.com"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_1',
          call_id: 'call_resp_1',
          type: 'function_call',
          name: 'web_fetch',
          arguments: '{"url":"https://example.com"}',
        },
      },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 150, output_tokens: 20 },
        },
      },
    ]

    const events: MessageStreamEvent[] = []
    for (const packet of packets) {
      events.push(...adapter.push(readOpenAIFrame('responses', packet)))
    }
    events.push(...adapter.finish())

    const start = events.find((e) => e.type === 'content_block_start')
    assert.deepEqual(start, {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_resp_1', name: 'web_fetch', input: {} },
    })
    const args = events
      .filter((e) => e.type === 'content_block_delta')
      .map((e) => (e.type === 'content_block_delta' && e.delta.type === 'input_json_delta' ? e.delta.partial_json : ''))
      .join('')
    assert.equal(args, '{"url":"https://example.com"}')

    const msgDelta = events.find((e) => e.type === 'message_delta')
    assert.ok(msgDelta && msgDelta.type === 'message_delta')
    assert.equal(msgDelta.delta.stop_reason, 'tool_use')
  })

  it('maps response.completed without function_call to end_turn', () => {
    const adapter = createOpenAIStreamAdapter()
    const events: MessageStreamEvent[] = [
      ...adapter.push(readOpenAIFrame('responses', { type: 'response.output_text.delta', delta: 'Done.' })),
      ...adapter.push(readOpenAIFrame('responses', { type: 'response.completed', response: { status: 'completed' } })),
      ...adapter.finish(),
    ]
    const msgDelta = events.find((e) => e.type === 'message_delta')
    assert.ok(msgDelta && msgDelta.type === 'message_delta')
    assert.equal(msgDelta.delta.stop_reason, 'end_turn')
  })
})

describe('Daily date snapshot folding across protocols', () => {
  const day1 = 'Current local date: 2026-11-27 (Friday, UTC+08:00).'
  const day2 = 'Current local date: 2026-11-28 (Saturday, UTC+08:00).'

  const makeHistory = (): Message[] => [
    { id: 'u1', role: 'user', content: 'First question', files: [], createdAt: 1 },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 2,
      model: 'gpt-5',
      prefix: false,
      status: 'done',
      latestReminder: day1,
      blocks: [{ type: 'text', text: 'First answer' }],
    },
  ]

  const q2: UserMessage = {
    id: 'u2',
    role: 'user',
    content: 'Follow-up same day',
    files: [],
    createdAt: 3,
  }

  const q3: UserMessage = {
    id: 'u3',
    role: 'user',
    content: 'Question next day',
    files: [],
    createdAt: 5,
  }

  it('deduplicates same-day snapshots and preserves historical prefix across turns', () => {
    const sameDayMessages = toRequestMessages(makeHistory(), q2, undefined, false, day1)
    const nextDayHistory: Message[] = [
      ...makeHistory(),
      q2,
      {
        id: 'a2',
        role: 'assistant',
        createdAt: 4,
        model: 'gpt-5',
        prefix: false,
        status: 'done',
        latestReminder: day1,
        blocks: [{ type: 'text', text: 'Second answer' }],
      },
    ]
    const nextDayMessages = toRequestMessages(nextDayHistory, q3, undefined, false, day2)

    const baseReq = {
      model: 'test-model',
      max_tokens: 1024,
      system: 'Static system prompt.',
      thinking: { type: 'disabled' as const },
    }

    const anthropicSameDay = customMessagesRequest({ ...baseReq, messages: sameDayMessages })
    const anthropicNextDay = customMessagesRequest({ ...baseReq, messages: nextDayMessages })
    assert.equal(anthropicSameDay.system, 'Static system prompt.')
    assert.deepEqual(anthropicSameDay.messages, [
      { role: 'user', content: `[${day1}]\n\nFirst question` },
      { role: 'assistant', content: [{ type: 'text', text: 'First answer' }] },
      { role: 'user', content: 'Follow-up same day' },
    ])
    assert.deepEqual(anthropicNextDay.messages.slice(0, 3), anthropicSameDay.messages)
    assert.deepEqual(anthropicNextDay.messages[4], {
      role: 'user',
      content: `[${day2}]\n\nQuestion next day`,
    })

    const chatSameDay = openAIRequest('chat', { ...baseReq, messages: sameDayMessages }, false) as {
      messages: Record<string, unknown>[]
    }
    const chatNextDay = openAIRequest('chat', { ...baseReq, messages: nextDayMessages }, false) as {
      messages: Record<string, unknown>[]
    }
    assert.deepEqual(chatSameDay.messages, [
      { role: 'system', content: 'Static system prompt.' },
      { role: 'user', content: `[${day1}]\n\nFirst question` },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Follow-up same day' },
    ])
    assert.deepEqual(chatNextDay.messages.slice(0, 4), chatSameDay.messages)
    assert.deepEqual(chatNextDay.messages[5], {
      role: 'user',
      content: `[${day2}]\n\nQuestion next day`,
    })

    const responsesNextDay = openAIRequest(
      'responses',
      { ...baseReq, messages: nextDayMessages },
      false
    ) as {
      instructions: string
      input: Record<string, unknown>[]
    }
    assert.equal(responsesNextDay.instructions, 'Static system prompt.')
    assert.deepEqual(responsesNextDay.input[0], {
      role: 'user',
      content: `[${day1}]\n\nFirst question`,
    })
    assert.deepEqual(responsesNextDay.input[2], {
      role: 'user',
      content: 'Follow-up same day',
    })
    assert.deepEqual(responsesNextDay.input[4], {
      role: 'user',
      content: `[${day2}]\n\nQuestion next day`,
    })
  })

  it('omits custom local-date snapshots when sending to official DeepSeek chat', () => {
    const req = openAIRequest(
      'chat',
      {
        model: 'deepseek-chat',
        max_tokens: 1024,
        system: 'Static',
        thinking: { type: 'disabled' },
        messages: [
          { role: 'latest_reminder', content: day1 },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
          { role: 'latest_reminder', content: '2026-11-28,星期六,成都,Web,中文' },
          { role: 'user', content: 'Next' },
        ],
      },
      true
    ) as { messages: Record<string, unknown>[] }

    assert.deepEqual(req.messages, [
      { role: 'system', content: 'Static' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'latest_reminder', content: '2026-11-28,星期六,成都,Web,中文' },
      { role: 'user', content: 'Next' },
    ])
  })
})
