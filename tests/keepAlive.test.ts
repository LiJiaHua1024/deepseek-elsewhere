import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  BACKGROUND_PERSIST_INTERVAL_MS,
  beginBackgroundStream,
  bindBackgroundKeepAlive,
  createStreamFlushController,
  deriveStreamPhase,
  finishBackgroundStream,
  getActiveBackgroundStreamsSnapshot,
  NOTIFICATION_PERMISSION_DELAY_MS,
  resetKeepAliveForTest,
  setKeepAliveEnvironmentForTest,
  updateBackgroundStream,
  type KeepAliveBridge,
} from '../src/elsewhere/keepAlive.js'
import {
  setBackgroundKeepAlive,
  setBackgroundNotify,
  setNotificationPermissionAsked,
} from '../src/elsewhere/preferences.js'
import {
  clearAllToolApprovals,
  requestToolConfirmation,
  resolveToolConfirmation,
  useToolConfirmations,
} from '../src/elsewhere/tools/confirmation.js'
import type { ClientToolDefinition } from '../src/elsewhere/tools/types.js'
import { settleReply } from '../src/services/chat/reply.js'
import type { AssistantMessage } from '../src/services/chat/types.js'

type SyncCall = {
  enabled: boolean
  sessions: Array<{ sessionId: string; title: string; phase: string; detail?: string }>
  locale: string
}

type NotifyCall = {
  sessionId: string
  title: string
  kind: 'done' | 'error' | 'awaiting_confirmation'
  detail?: string
  locale: string
}

const createHarness = () => {
  const syncCalls: SyncCall[] = []
  const notifyCalls: NotifyCall[] = []
  const clearedIds: string[] = []
  let permissionRequests = 0
  let hidden = false
  let currentTime = 1_000
  let nextTimerId = 1
  const timers = new Map<number, { fn: () => void; at: number }>()

  const bridge: KeepAliveBridge = {
    syncKeepAlive: (payloadJson) => {
      syncCalls.push(JSON.parse(payloadJson) as SyncCall)
    },
    notifyBackgroundEvent: (payloadJson) => {
      notifyCalls.push(JSON.parse(payloadJson) as NotifyCall)
    },
    clearSessionNotification: (sessionId) => {
      clearedIds.push(sessionId)
    },
    requestNotificationPermission: () => {
      permissionRequests += 1
    },
    areNotificationsEnabled: () => true,
  }

  setKeepAliveEnvironmentForTest({
    getBridge: () => bridge,
    isHidden: () => hidden,
    getLocale: () => 'zh-CN',
    now: () => currentTime,
    setTimer: (fn, ms) => {
      const id = nextTimerId++
      timers.set(id, { fn, at: currentTime + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      timers.delete(timer as unknown as number)
    },
  })

  const advanceTime = (ms: number) => {
    currentTime += ms
    for (const [id, entry] of Array.from(timers.entries())) {
      if (entry.at <= currentTime) {
        timers.delete(id)
        entry.fn()
      }
    }
  }

  return {
    syncCalls,
    notifyCalls,
    clearedIds,
    getPermissionRequests: () => permissionRequests,
    setHidden: (value: boolean) => {
      hidden = value
    },
    advanceTime,
    setNow: (value: number) => {
      currentTime = value
    },
    pendingTimerCount: () => timers.size,
  }
}

const makeReply = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 1000,
  model: 'deepseek-chat',
  thinking: false,
  search: false,
  prefix: false,
  status: 'streaming',
  blocks: [],
  ...overrides,
})

beforeEach(() => {
  resetKeepAliveForTest()
  setBackgroundKeepAlive(true)
  setBackgroundNotify(true)
  setNotificationPermissionAsked(false)
})

afterEach(() => {
  clearAllToolApprovals()
  resetKeepAliveForTest()
  const win = globalThis as { __elsewherePendingOpenSession?: string }
  delete win.__elsewherePendingOpenSession
})

describe('keepAlive multi-session state machine and bindings', () => {
  it('tracks 0 -> 1 -> 2 -> 1 -> 0 lifecycle, deduplicates updates, and stops only at 0', () => {
    const h = createHarness()

    beginBackgroundStream('s1', { title: 'Session 1', isLongTask: true })
    assert.equal(h.syncCalls.length, 1)
    assert.equal(h.syncCalls[0].enabled, true)
    assert.deepEqual(h.syncCalls[0].sessions, [
      { sessionId: 's1', title: 'Session 1', phase: 'streaming' },
    ])

    // Identical phase update is deduplicated
    updateBackgroundStream('s1', { phase: 'streaming' })
    assert.equal(h.syncCalls.length, 1)

    // Tool phase change triggers sync
    updateBackgroundStream('s1', { phase: 'tool', detail: 'AnySearch' })
    assert.equal(h.syncCalls.length, 2)
    assert.deepEqual(h.syncCalls[1].sessions, [
      { sessionId: 's1', title: 'Session 1', phase: 'tool', detail: 'AnySearch' },
    ])

    // Parallel session s2 starts -> count 2
    beginBackgroundStream('s2', { title: '', isLongTask: false })
    assert.equal(h.syncCalls.length, 3)
    assert.equal(h.syncCalls[2].sessions.length, 2)

    // s1 finishes -> s2 remains active (count 1), service stays running
    finishBackgroundStream('s1', { outcome: 'done', title: 'Session 1' })
    assert.equal(h.syncCalls.length, 4)
    assert.deepEqual(h.syncCalls[3].sessions, [{ sessionId: 's2', title: '', phase: 'streaming' }])

    // s2 finishes -> count reaches 0, service stops
    finishBackgroundStream('s2', { outcome: 'done', title: 'Session 2' })
    assert.equal(h.syncCalls.length, 5)
    assert.equal(h.syncCalls[4].enabled, true)
    assert.deepEqual(h.syncCalls[4].sessions, [])
    assert.equal(getActiveBackgroundStreamsSnapshot().length, 0)
  })

  it('derives stream phase accurately across awaiting_confirmation, tool, server tool, and streaming', () => {
    assert.deepEqual(deriveStreamPhase(makeReply()), { phase: 'streaming' })

    assert.deepEqual(
      deriveStreamPhase(
        makeReply({
          blocks: [{ type: 'server_tool_use', id: 'su-1', name: 'deepseek_web_search', input: {} }],
        })
      ),
      { phase: 'tool' }
    )

    assert.deepEqual(
      deriveStreamPhase(
        makeReply({
          blocks: [
            {
              type: 'client_tool_call',
              id: 'c1',
              name: 'run_python',
              source: 'builtin',
              input: {},
              status: 'running',
              startedAt: 1000,
            },
          ],
        })
      ),
      { phase: 'tool', detail: 'Python' }
    )

    assert.deepEqual(
      deriveStreamPhase(
        makeReply({
          blocks: [
            {
              type: 'client_tool_call',
              id: 'c2',
              name: 'mcp__fs__write',
              displayName: 'write',
              source: 'mcp',
              serverName: 'Filesystem',
              input: {},
              status: 'awaiting_confirmation',
              startedAt: 1000,
            },
          ],
        })
      ),
      { phase: 'awaiting_confirmation', detail: 'Filesystem' }
    )
  })

  it('immediately stops native keep-alive when backgroundKeepAlive is turned off', () => {
    const h = createHarness()
    const eventTarget = new EventTarget()
    const visibilityTarget = new EventTarget()
    const unbind = bindBackgroundKeepAlive({
      stopSession: () => {},
      stopAllSessions: () => {},
      openSession: () => {},
      getActiveSessionId: () => 's1',
      eventTarget,
      visibilityTarget,
    })

    beginBackgroundStream('s1', { title: 'Test', isLongTask: true })
    assert.equal(h.syncCalls.at(-1)?.enabled, true)
    assert.equal(h.syncCalls.at(-1)?.sessions.length, 1)

    setBackgroundKeepAlive(false)
    assert.equal(h.syncCalls.at(-1)?.enabled, false)
    assert.deepEqual(h.syncCalls.at(-1)?.sessions, [])

    unbind()
  })

  it('dispatches android-stop-stream for single or all sessions and handles android-open-session', async () => {
    const h = createHarness()
    const eventTarget = new EventTarget()
    const visibilityTarget = new EventTarget()
    const stopped: string[] = []
    let stopAllCount = 0
    const opened: string[] = []
    let activeId: string | null = 's2'

    // Simulate cold start pending session before binding
    ;(globalThis as { __elsewherePendingOpenSession?: string }).__elsewherePendingOpenSession =
      's-cold'

    const unbind = bindBackgroundKeepAlive({
      stopSession: (id) => stopped.push(id),
      stopAllSessions: () => {
        stopAllCount += 1
      },
      openSession: async (id) => {
        opened.push(id)
        activeId = id
      },
      getActiveSessionId: () => activeId,
      eventTarget,
      visibilityTarget,
    })

    await Promise.resolve()
    assert.deepEqual(opened, ['s-cold'])
    assert.ok(h.clearedIds.includes('s-cold'))

    eventTarget.dispatchEvent(new CustomEvent('android-stop-stream', { detail: { sessionId: 's1' } }))
    assert.deepEqual(stopped, ['s1'])
    assert.equal(stopAllCount, 0)

    eventTarget.dispatchEvent(new CustomEvent('android-stop-stream', { detail: { sessionId: null } }))
    assert.equal(stopAllCount, 1)

    eventTarget.dispatchEvent(new CustomEvent('android-open-session', { detail: { sessionId: 's3' } }))
    await Promise.resolve()
    assert.deepEqual(opened, ['s-cold', 's3'])
    assert.ok(h.clearedIds.includes('s3'))

    // Returning to foreground clears active session notification
    h.setHidden(false)
    visibilityTarget.dispatchEvent(new Event('visibilitychange'))
    assert.equal(h.clearedIds.at(-1), 's3')

    unbind()
  })

  it('clears session notification when tool confirmation is resolved', async () => {
    const h = createHarness()
    const tool: ClientToolDefinition = {
      name: 'mcp__notes__append',
      displayName: 'append',
      description: 'Append note',
      inputSchema: { type: 'object', properties: {} },
      source: 'mcp',
      serverId: 'srv-notes',
      serverName: 'Notes',
      autoApprove: false,
      readOnly: false,
      execute: async () => ({ content: 'ok' }),
    }
    const signal = new AbortController().signal
    const pending = requestToolConfirmation({
      sessionId: 's-confirm',
      callId: 'call-1',
      tool,
      input: {},
      signal,
    })

    const item = useToolConfirmations.getState().queue[0]
    assert.ok(item)
    resolveToolConfirmation(item.id, 'allow_once')
    assert.equal(await pending, 'allow')
    assert.deepEqual(h.clearedIds, ['s-confirm'])
  })
})

describe('notification permission timing and background notification gating', () => {
  it('does not request notification permission for fast (< 3s) non-long replies', () => {
    const h = createHarness()

    beginBackgroundStream('fast-1', { title: 'Hi', isLongTask: false })
    assert.equal(h.getPermissionRequests(), 0)
    assert.equal(h.pendingTimerCount(), 1)

    h.advanceTime(NOTIFICATION_PERMISSION_DELAY_MS - 100)
    assert.equal(h.getPermissionRequests(), 0)

    finishBackgroundStream('fast-1', { outcome: 'done', title: 'Hi' })
    assert.equal(h.pendingTimerCount(), 0)

    h.advanceTime(5_000)
    assert.equal(h.getPermissionRequests(), 0)
  })

  it('does not request permission while hidden in background, and requests once for >3s or long tasks', () => {
    const h = createHarness()

    // Background after 1s -> timer fires at 3s but app is hidden, so do not ask
    beginBackgroundStream('slow-bg', { title: 'Slow', isLongTask: false })
    h.advanceTime(1_000)
    h.setHidden(true)
    h.advanceTime(NOTIFICATION_PERMISSION_DELAY_MS)
    assert.equal(h.getPermissionRequests(), 0)
    finishBackgroundStream('slow-bg', { outcome: 'stopped', title: 'Slow' })

    // Foreground >3s reply asks once
    h.setHidden(false)
    beginBackgroundStream('slow-fg', { title: 'Slow FG', isLongTask: false })
    h.advanceTime(NOTIFICATION_PERMISSION_DELAY_MS)
    assert.equal(h.getPermissionRequests(), 1)
    finishBackgroundStream('slow-fg', { outcome: 'done', title: 'Slow FG' })

    // Subsequent long task must never ask again
    beginBackgroundStream('long-2', { title: 'Think', isLongTask: true })
    assert.equal(h.getPermissionRequests(), 1)
    finishBackgroundStream('long-2', { outcome: 'done', title: 'Think' })
  })

  it('requests permission immediately once for long tasks while in foreground', () => {
    const h = createHarness()

    beginBackgroundStream('long-1', { title: 'Deep Think', isLongTask: true })
    assert.equal(h.getPermissionRequests(), 1)
    assert.equal(h.pendingTimerCount(), 0)
    finishBackgroundStream('long-1', { outcome: 'done', title: 'Deep Think' })

    beginBackgroundStream('long-2', { title: 'Search', isLongTask: true })
    assert.equal(h.getPermissionRequests(), 1)
    finishBackgroundStream('long-2', { outcome: 'done', title: 'Search' })
  })

  it('suppresses notifications in foreground and isolates per-session notifications in background', () => {
    const h = createHarness()

    // Foreground: browsing session B while session A finishes or awaits confirmation -> silent
    h.setHidden(false)
    beginBackgroundStream('sA', { title: 'Chat A', isLongTask: true })
    updateBackgroundStream('sA', { phase: 'awaiting_confirmation', detail: 'GitHub' })
    finishBackgroundStream('sA', { outcome: 'done', title: 'Chat A' })
    assert.equal(h.notifyCalls.length, 0)

    // Background: emits awaiting_confirmation, done, error per session, skips stopped
    h.setHidden(true)
    beginBackgroundStream('s1', { title: 'Chat 1', isLongTask: true })
    beginBackgroundStream('s2', { title: 'Chat 2', isLongTask: true })
    beginBackgroundStream('s3', { title: 'Chat 3', isLongTask: true })

    updateBackgroundStream('s1', { phase: 'awaiting_confirmation', detail: 'AnySearch' })
    // Duplicate awaiting update with different unrelated state does not duplicate alert
    updateBackgroundStream('s1', { phase: 'awaiting_confirmation', detail: 'AnySearch' })
    finishBackgroundStream('s1', { outcome: 'done', title: 'Chat 1' })
    finishBackgroundStream('s2', { outcome: 'error', title: 'Chat 2' })
    finishBackgroundStream('s3', { outcome: 'stopped', title: 'Chat 3' })

    assert.deepEqual(
      h.notifyCalls.map(({ sessionId, title, kind, detail }) => ({ sessionId, title, kind, detail })),
      [
        {
          sessionId: 's1',
          title: 'Chat 1',
          kind: 'awaiting_confirmation',
          detail: 'AnySearch',
        },
        { sessionId: 's1', title: 'Chat 1', kind: 'done', detail: undefined },
        { sessionId: 's2', title: 'Chat 2', kind: 'error', detail: undefined },
      ]
    )

    // Disabled notify suppresses background alerts
    setBackgroundNotify(false)
    beginBackgroundStream('s4', { title: 'Chat 4', isLongTask: true })
    finishBackgroundStream('s4', { outcome: 'done', title: 'Chat 4' })
    assert.equal(h.notifyCalls.length, 3)
  })
})

describe('background streaming persistence without requestAnimationFrame', () => {
  it('flushes synchronously and persists on critical changes or >5s interval when hidden, then cancels rAF and persists on settle', () => {
    const h = createHarness()
    let hidden = true
    let now = 10_000
    let rafIdCounter = 1
    const pendingRafs = new Map<number, () => void>()
    const callOrder: string[] = []
    let persistedCount = 0
    let flushedReply: AssistantMessage | null = null
    let currentReply = makeReply({ status: 'pending' })

    const controller = createStreamFlushController({
      isHidden: () => hidden,
      now: () => now,
      raf: (cb) => {
        const id = rafIdCounter++
        pendingRafs.set(id, cb)
        return id
      },
      caf: (id) => {
        pendingRafs.delete(id)
      },
      onFlush: () => {
        flushedReply = currentReply
        callOrder.push(`flush:${currentReply.status}:${currentReply.blocks.length}`)
      },
      onPersist: () => {
        persistedCount += 1
        callOrder.push(`persist:${currentReply.status}`)
      },
    })

    // First text chunk while hidden -> flushes synchronously without queuing rAF, no persist yet (<5s)
    currentReply = makeReply({
      status: 'streaming',
      blocks: [{ type: 'text', text: 'Hello' }],
    })
    controller.schedule(false)
    assert.equal(pendingRafs.size, 0)
    assert.equal((flushedReply as AssistantMessage | null)?.blocks.length, 1)
    assert.equal(persistedCount, 0)

    // Critical change (e.g. tool call start) -> flushes and persists immediately even within 5s
    now += 500
    controller.schedule(true)
    assert.equal(persistedCount, 1)

    // Within 5s non-critical chunk -> flushes memory without persisting again
    now += 1_000
    currentReply = makeReply({
      status: 'streaming',
      blocks: [{ type: 'text', text: 'Hello world' }],
    })
    controller.schedule(false)
    assert.equal(persistedCount, 1)

    // After >= 5s while hidden -> flushes and persists snapshot automatically
    now += BACKGROUND_PERSIST_INTERVAL_MS
    currentReply = makeReply({
      status: 'streaming',
      blocks: [{ type: 'text', text: 'Hello world!' }],
    })
    controller.schedule(false)
    assert.equal(persistedCount, 2)

    // Switch visible, queue a rAF, switch back hidden and settle before rAF fires
    hidden = false
    currentReply = makeReply({
      status: 'streaming',
      blocks: [{ type: 'text', text: 'Pending frame' }],
    })
    controller.schedule(false)
    assert.equal(pendingRafs.size, 1)

    hidden = true
    h.setHidden(true)
    beginBackgroundStream('bg-persist', { title: 'Persist Test', isLongTask: true })
    currentReply = settleReply(currentReply, 'done', now + 100)
    controller.cancel()
    assert.equal(pendingRafs.size, 0)
    controller.flushNow(true)
    finishBackgroundStream('bg-persist', { outcome: 'done', title: 'Persist Test' })

    assert.equal((flushedReply as AssistantMessage | null)?.status, 'done')
    assert.equal(persistedCount, 3)
    assert.equal(callOrder.at(-1), 'persist:done')
    assert.equal(h.notifyCalls.length, 1)
    assert.equal(h.notifyCalls[0].kind, 'done')
  })

  it('flushes dirty pending frame immediately when returning to visible', () => {
    let hidden = false
    let flushes = 0
    const pendingRafs = new Map<number, () => void>()
    let nextRafId = 1

    const controller = createStreamFlushController({
      isHidden: () => hidden,
      now: () => 1_000,
      raf: (cb) => {
        const id = nextRafId++
        pendingRafs.set(id, cb)
        return id
      },
      caf: (id) => {
        pendingRafs.delete(id)
      },
      onFlush: () => {
        flushes += 1
      },
      onPersist: () => {},
    })

    controller.schedule(false)
    assert.equal(flushes, 0)
    assert.equal(pendingRafs.size, 1)

    // Returning to visible triggers flushIfDirty immediately and cancels the stale rAF
    hidden = false
    controller.flushIfDirty()
    assert.equal(flushes, 1)
    assert.equal(pendingRafs.size, 0)
  })
})
