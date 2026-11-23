import { useSettings } from '../services/settings.js'
import type { AssistantMessage } from '../services/chat/types.js'
import { setNotificationPermissionAsked, useElsewherePrefs } from './preferences.js'

export type BackgroundStreamPhase = 'streaming' | 'tool' | 'awaiting_confirmation'
export type BackgroundStreamOutcome = 'done' | 'error' | 'stopped'

export type ActiveStreamState = {
  sessionId: string
  title: string
  phase: BackgroundStreamPhase
  detail?: string
  startedAt: number
}

export type KeepAliveBridge = {
  syncKeepAlive?: (payloadJson: string) => void
  notifyBackgroundEvent?: (payloadJson: string) => void
  clearSessionNotification?: (sessionId: string) => void
  requestNotificationPermission?: () => void
  areNotificationsEnabled?: () => boolean
}

export type KeepAliveEnvironment = {
  getBridge: () => KeepAliveBridge | undefined
  isHidden: () => boolean
  getLocale: () => string
  now: () => number
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
}

export type BackgroundKeepAliveHandlers = {
  stopSession: (sessionId: string) => void
  stopAllSessions: () => void
  openSession: (sessionId: string) => void | Promise<void>
  getActiveSessionId: () => string | null
  eventTarget?: EventTarget
  visibilityTarget?: EventTarget
}

export type StreamFlushControllerOptions = {
  onFlush: () => void
  onPersist: () => void
  isHidden?: () => boolean
  now?: () => number
  raf?: (cb: () => void) => number
  caf?: (id: number) => void
  persistIntervalMs?: number
}

export type StreamFlushController = {
  schedule: (critical?: boolean) => void
  flushNow: (shouldPersist?: boolean) => void
  flushIfDirty: () => void
  markPersisted: () => void
  cancel: () => void
}

export const NOTIFICATION_PERMISSION_DELAY_MS = 3_000
export const BACKGROUND_PERSIST_INTERVAL_MS = 5_000

const defaultEnv: KeepAliveEnvironment = {
  getBridge: () =>
    typeof window === 'undefined'
      ? undefined
      : (window as Window & { DeepSeekAndroid?: KeepAliveBridge }).DeepSeekAndroid,
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  getLocale: () => useSettings.getState().locale,
  now: () => Date.now(),
  setTimer: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimer: (timer) => globalThis.clearTimeout(timer),
}

let env: KeepAliveEnvironment = defaultEnv

const activeStreams = new Map<string, ActiveStreamState>()
const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const lastAwaitingNotifiedKey = new Map<string, string>()
let lastSyncedSignature: string | null = null

const buildSyncPayload = (): string => {
  const enabled = useElsewherePrefs.getState().backgroundKeepAlive
  const sessions = enabled
    ? Array.from(activeStreams.values(), ({ sessionId, title, phase, detail }) => ({
        sessionId,
        title,
        phase,
        ...(detail ? { detail } : {}),
      }))
    : []
  return JSON.stringify({
    enabled,
    sessions,
    locale: env.getLocale(),
  })
}

const flushSync = () => {
  const bridge = env.getBridge()
  if (!bridge?.syncKeepAlive) {
    return
  }
  const payloadJson = buildSyncPayload()
  if (payloadJson === lastSyncedSignature) {
    return
  }
  lastSyncedSignature = payloadJson
  bridge.syncKeepAlive(payloadJson)
}

const clearPermissionTimer = (sessionId: string) => {
  const timer = permissionTimers.get(sessionId)
  if (timer !== undefined) {
    env.clearTimer(timer)
    permissionTimers.delete(sessionId)
  }
}

const maybeSchedulePermissionRequest = (sessionId: string, isLongTask: boolean) => {
  const bridge = env.getBridge()
  if (!bridge?.requestNotificationPermission) {
    return
  }
  const prefs = useElsewherePrefs.getState()
  if ((!prefs.backgroundKeepAlive && !prefs.backgroundNotify) || prefs.notificationPermissionAsked) {
    return
  }

  const trigger = () => {
    permissionTimers.delete(sessionId)
    const latestPrefs = useElsewherePrefs.getState()
    if (
      latestPrefs.notificationPermissionAsked ||
      (!latestPrefs.backgroundKeepAlive && !latestPrefs.backgroundNotify)
    ) {
      return
    }
    if (!activeStreams.has(sessionId) || env.isHidden()) {
      return
    }
    setNotificationPermissionAsked(true)
    env.getBridge()?.requestNotificationPermission?.()
  }

  if (isLongTask) {
    trigger()
    return
  }

  clearPermissionTimer(sessionId)
  const timer = env.setTimer(trigger, NOTIFICATION_PERMISSION_DELAY_MS)
  permissionTimers.set(sessionId, timer)
}

const maybeNotifyBackgroundEvent = (payload: {
  sessionId: string
  title: string
  kind: 'done' | 'error' | 'awaiting_confirmation'
  detail?: string
}) => {
  const bridge = env.getBridge()
  if (!bridge?.notifyBackgroundEvent) {
    return
  }
  if (!useElsewherePrefs.getState().backgroundNotify || !env.isHidden()) {
    return
  }
  bridge.notifyBackgroundEvent(
    JSON.stringify({
      sessionId: payload.sessionId,
      title: payload.title,
      kind: payload.kind,
      ...(payload.detail ? { detail: payload.detail } : {}),
      locale: env.getLocale(),
    })
  )
}

export const beginBackgroundStream = (
  sessionId: string,
  { title, isLongTask }: { title?: string; isLongTask?: boolean } = {}
) => {
  const normalizedTitle = title?.trim() ?? ''
  activeStreams.set(sessionId, {
    sessionId,
    title: normalizedTitle,
    phase: 'streaming',
    startedAt: env.now(),
  })
  lastAwaitingNotifiedKey.delete(sessionId)
  flushSync()
  maybeSchedulePermissionRequest(sessionId, Boolean(isLongTask))
}

export const updateBackgroundStream = (
  sessionId: string,
  patch: { title?: string; phase?: BackgroundStreamPhase; detail?: string }
) => {
  const current = activeStreams.get(sessionId)
  if (!current) {
    return
  }
  const nextTitle = patch.title !== undefined ? patch.title.trim() : current.title
  const nextPhase = patch.phase ?? current.phase
  const nextDetail =
    patch.detail !== undefined
      ? patch.detail.trim() || undefined
      : patch.phase !== undefined
        ? undefined
        : current.detail

  if (
    nextTitle === current.title &&
    nextPhase === current.phase &&
    nextDetail === current.detail
  ) {
    return
  }

  activeStreams.set(sessionId, {
    ...current,
    title: nextTitle,
    phase: nextPhase,
    detail: nextDetail,
  })
  flushSync()

  if (nextPhase === 'awaiting_confirmation') {
    const notifyKey = `${nextTitle}\0${nextDetail ?? ''}`
    if (lastAwaitingNotifiedKey.get(sessionId) !== notifyKey) {
      lastAwaitingNotifiedKey.set(sessionId, notifyKey)
      maybeNotifyBackgroundEvent({
        sessionId,
        title: nextTitle,
        kind: 'awaiting_confirmation',
        detail: nextDetail,
      })
    }
  } else {
    lastAwaitingNotifiedKey.delete(sessionId)
  }
}

export const finishBackgroundStream = (
  sessionId: string,
  { outcome, title }: { outcome: BackgroundStreamOutcome; title?: string }
) => {
  clearPermissionTimer(sessionId)
  lastAwaitingNotifiedKey.delete(sessionId)
  const existing = activeStreams.get(sessionId)
  const resolvedTitle = (title ?? existing?.title ?? '').trim()
  activeStreams.delete(sessionId)
  flushSync()

  if (outcome === 'done' || outcome === 'error') {
    maybeNotifyBackgroundEvent({
      sessionId,
      title: resolvedTitle,
      kind: outcome,
    })
  }
}

export const clearSessionNotification = (sessionId: string | null | undefined) => {
  if (!sessionId) {
    return
  }
  env.getBridge()?.clearSessionNotification?.(sessionId)
}

export const deriveStreamPhase = (
  reply: AssistantMessage
): { phase: BackgroundStreamPhase; detail?: string } => {
  for (const block of reply.blocks) {
    if (block.type === 'client_tool_call' && block.status === 'awaiting_confirmation') {
      const detail = block.serverName?.trim() || block.displayName?.trim() || block.name
      return { phase: 'awaiting_confirmation', ...(detail ? { detail } : {}) }
    }
  }
  for (const block of reply.blocks) {
    if (block.type === 'client_tool_call' && block.status === 'running') {
      const detail =
        block.name === 'run_python'
          ? 'Python'
          : block.serverName?.trim() ||
            block.displayName?.trim() ||
            (block.source === 'mcp' ? block.name : undefined)
      return { phase: 'tool', ...(detail ? { detail } : {}) }
    }
  }
  const finishedServerToolIds = new Set<string>()
  for (const block of reply.blocks) {
    if (
      block.type === 'web_search_tool_result' ||
      block.type === 'web_fetch_tool_result'
    ) {
      finishedServerToolIds.add(block.tool_use_id)
    }
  }
  for (const block of reply.blocks) {
    if (block.type === 'server_tool_use' && !finishedServerToolIds.has(block.id)) {
      return { phase: 'tool' }
    }
  }
  return { phase: 'streaming' }
}

export const createStreamFlushController = ({
  onFlush,
  onPersist,
  isHidden = () => env.isHidden(),
  now = () => env.now(),
  raf = (cb) => requestAnimationFrame(cb),
  caf = (id) => cancelAnimationFrame(id),
  persistIntervalMs = BACKGROUND_PERSIST_INTERVAL_MS,
}: StreamFlushControllerOptions): StreamFlushController => {
  let frame = 0
  let dirty = false
  let lastPersistedAt = now()

  const cancelFrame = () => {
    if (frame !== 0) {
      caf(frame)
      frame = 0
    }
  }

  return {
    schedule(critical = false) {
      if (isHidden()) {
        cancelFrame()
        dirty = false
        onFlush()
        const currentTime = now()
        if (critical || currentTime - lastPersistedAt >= persistIntervalMs) {
          onPersist()
          lastPersistedAt = currentTime
        }
        return
      }
      if (critical) {
        cancelFrame()
        dirty = false
        onFlush()
        return
      }
      dirty = true
      if (frame === 0) {
        frame = raf(() => {
          frame = 0
          dirty = false
          onFlush()
        })
      }
    },
    flushNow(shouldPersist = false) {
      cancelFrame()
      dirty = false
      onFlush()
      if (shouldPersist) {
        onPersist()
        lastPersistedAt = now()
      }
    },
    flushIfDirty() {
      if (dirty || frame !== 0) {
        cancelFrame()
        dirty = false
        onFlush()
      }
    },
    markPersisted() {
      lastPersistedAt = now()
    },
    cancel() {
      cancelFrame()
      dirty = false
    },
  }
}

export const bindBackgroundKeepAlive = ({
  stopSession,
  stopAllSessions,
  openSession,
  getActiveSessionId,
  eventTarget = typeof window !== 'undefined' ? window : undefined,
  visibilityTarget = typeof document !== 'undefined' ? document : undefined,
}: BackgroundKeepAliveHandlers): (() => void) => {
  const handleOpen = (sessionId: string) => {
    clearSessionNotification(sessionId)
    void Promise.resolve(openSession(sessionId)).then(() => {
      clearSessionNotification(sessionId)
    })
  }

  const onStopStream = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId
    if (typeof sessionId === 'string' && sessionId) {
      stopSession(sessionId)
    } else {
      stopAllSessions()
    }
  }

  const onOpenSession = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string | null }>).detail?.sessionId
    if (typeof sessionId === 'string' && sessionId) {
      const win = globalThis as { __elsewherePendingOpenSession?: string }
      if (win.__elsewherePendingOpenSession === sessionId) {
        win.__elsewherePendingOpenSession = undefined
      }
      handleOpen(sessionId)
    }
  }

  const onVisibilityChange = () => {
    if (!env.isHidden()) {
      clearSessionNotification(getActiveSessionId())
    }
  }

  let prevKeepAlive = useElsewherePrefs.getState().backgroundKeepAlive
  const unsubscribePrefs = useElsewherePrefs.subscribe((state) => {
    if (state.backgroundKeepAlive !== prevKeepAlive) {
      prevKeepAlive = state.backgroundKeepAlive
      flushSync()
    }
  })

  eventTarget?.addEventListener('android-stop-stream', onStopStream)
  eventTarget?.addEventListener('android-open-session', onOpenSession)
  visibilityTarget?.addEventListener('visibilitychange', onVisibilityChange)

  const pendingWin = globalThis as { __elsewherePendingOpenSession?: string }
  const pendingSessionId = pendingWin.__elsewherePendingOpenSession
  if (typeof pendingSessionId === 'string' && pendingSessionId) {
    pendingWin.__elsewherePendingOpenSession = undefined
    handleOpen(pendingSessionId)
  }

  return () => {
    unsubscribePrefs()
    eventTarget?.removeEventListener('android-stop-stream', onStopStream)
    eventTarget?.removeEventListener('android-open-session', onOpenSession)
    visibilityTarget?.removeEventListener('visibilitychange', onVisibilityChange)
  }
}

export const getActiveBackgroundStreamsSnapshot = (): ActiveStreamState[] =>
  Array.from(activeStreams.values())

export const setKeepAliveEnvironmentForTest = (override: Partial<KeepAliveEnvironment> | null) => {
  env = override ? { ...defaultEnv, ...override } : defaultEnv
}

export const resetKeepAliveForTest = () => {
  for (const timer of permissionTimers.values()) {
    env.clearTimer(timer)
  }
  permissionTimers.clear()
  activeStreams.clear()
  lastAwaitingNotifiedKey.clear()
  lastSyncedSignature = null
  env = defaultEnv
}
