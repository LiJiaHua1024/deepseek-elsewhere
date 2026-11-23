import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import {
  clearAllToolApprovals,
  clearSessionToolApprovals,
  isServerApprovedForSession,
  requestToolConfirmation,
  resolveToolConfirmation,
  useToolConfirmations,
} from '../src/elsewhere/tools/confirmation.js'
import type { ClientToolDefinition } from '../src/elsewhere/tools/types.js'

const makeMcpTool = (overrides: Partial<ClientToolDefinition> = {}): ClientToolDefinition => ({
  name: 'mcp__docs__fetch',
  displayName: 'fetch',
  description: 'Fetch doc',
  inputSchema: { type: 'object', properties: {} },
  source: 'mcp',
  serverId: 'srv-a',
  serverName: 'Docs',
  autoApprove: false,
  readOnly: false,
  execute: async () => ({ content: 'ok' }),
  ...overrides,
})

afterEach(() => {
  clearAllToolApprovals()
})

describe('tool confirmation workflow', () => {
  it('bypasses confirmation for builtin tools and autoApprove MCP tools', async () => {
    const builtin: ClientToolDefinition = {
      ...makeMcpTool(),
      name: 'web_search',
      source: 'builtin',
      serverId: undefined,
      serverName: undefined,
      readOnly: true,
    }
    const autoMcp = makeMcpTool({ autoApprove: true })
    const signal = new AbortController().signal

    assert.equal(
      await requestToolConfirmation({ sessionId: 's1', callId: 'c1', tool: builtin, input: {}, signal }),
      'allow'
    )
    assert.equal(
      await requestToolConfirmation({ sessionId: 's1', callId: 'c2', tool: autoMcp, input: {}, signal }),
      'allow'
    )
    assert.equal(useToolConfirmations.getState().queue.length, 0)
  })

  it('queues awaiting confirmations and supports deny & allow_once', async () => {
    const tool = makeMcpTool()
    const signal = new AbortController().signal
    let awaited = false

    const pDeny = requestToolConfirmation({
      sessionId: 's1',
      callId: 'c1',
      tool,
      input: { path: '/a' },
      signal,
      onAwaiting: () => {
        awaited = true
      },
    })
    assert.equal(awaited, true)
    assert.equal(useToolConfirmations.getState().queue.length, 1)
    const idDeny = useToolConfirmations.getState().queue[0].id
    resolveToolConfirmation(idDeny, 'deny')
    assert.equal(await pDeny, 'deny')
    assert.equal(useToolConfirmations.getState().queue.length, 0)

    const pOnce = requestToolConfirmation({
      sessionId: 's1',
      callId: 'c2',
      tool,
      input: {},
      signal,
    })
    resolveToolConfirmation(useToolConfirmations.getState().queue[0].id, 'allow_once')
    assert.equal(await pOnce, 'allow')

    // Second call must confirm again because allow_once was used
    const pSecond = requestToolConfirmation({
      sessionId: 's1',
      callId: 'c3',
      tool,
      input: {},
      signal,
    })
    assert.equal(useToolConfirmations.getState().queue.length, 1)
    resolveToolConfirmation(useToolConfirmations.getState().queue[0].id, 'deny')
    assert.equal(await pSecond, 'deny')
  })

  it('allows server for current session including siblings while isolating other sessions', async () => {
    const tool = makeMcpTool({ serverId: 'srv-1' })
    const signal = new AbortController().signal

    const p1 = requestToolConfirmation({ sessionId: 's1', callId: 'c1', tool, input: {}, signal })
    const p2 = requestToolConfirmation({ sessionId: 's1', callId: 'c2', tool, input: {}, signal })
    const pOtherSession = requestToolConfirmation({
      sessionId: 's2',
      callId: 'c3',
      tool,
      input: {},
      signal,
    })

    assert.equal(useToolConfirmations.getState().queue.length, 3)
    const firstId = useToolConfirmations.getState().queue[0].id
    resolveToolConfirmation(firstId, 'allow_session')

    assert.equal(await p1, 'allow')
    assert.equal(await p2, 'allow')
    assert.equal(isServerApprovedForSession('s1', 'srv-1'), true)
    assert.equal(isServerApprovedForSession('s2', 'srv-1'), false)

    // Remaining item belongs to s2
    assert.equal(useToolConfirmations.getState().queue.length, 1)
    assert.equal(useToolConfirmations.getState().queue[0].sessionId, 's2')

    // Subsequent call in s1 succeeds immediately
    assert.equal(
      await requestToolConfirmation({ sessionId: 's1', callId: 'c4', tool, input: {}, signal }),
      'allow'
    )

    // Clearing s1 approval forces confirmation again
    clearSessionToolApprovals('s1')
    assert.equal(isServerApprovedForSession('s1', 'srv-1'), false)

    resolveToolConfirmation(useToolConfirmations.getState().queue[0].id, 'deny')
    assert.equal(await pOtherSession, 'deny')
  })

  it('rejects and removes pending confirmations on AbortSignal abort', async () => {
    const controller = new AbortController()
    const tool = makeMcpTool()
    const pending = requestToolConfirmation({
      sessionId: 's1',
      callId: 'c1',
      tool,
      input: {},
      signal: controller.signal,
    })
    assert.equal(useToolConfirmations.getState().queue.length, 1)
    controller.abort(new DOMException('Stopped by user', 'AbortError'))

    await assert.rejects(pending, { name: 'AbortError' })
    assert.equal(useToolConfirmations.getState().queue.length, 0)
  })
})
