import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import type { ClientToolDefinition } from './types.js'

export type ToolConfirmationDecision = 'deny' | 'allow_once' | 'allow_session'

export type PendingToolConfirmation = {
  id: string
  sessionId: string
  callId: string
  toolName: string
  displayName: string
  serverId?: string
  serverName?: string
  input: Record<string, unknown>
  createdAt: number
}

type ConfirmationState = {
  queue: PendingToolConfirmation[]
}

export const useToolConfirmations = create<ConfirmationState>(() => ({ queue: [] }))

const sessionApprovedServers = new Map<string, Set<string>>()
const resolvers = new Map<string, (decision: 'allow' | 'deny') => void>()

const removeFromQueue = (id: string) => {
  useToolConfirmations.setState((state) => ({
    queue: state.queue.filter((item) => item.id !== id),
  }))
}

export const isServerApprovedForSession = (sessionId: string, serverId: string): boolean =>
  Boolean(sessionApprovedServers.get(sessionId)?.has(serverId))

export const approveServerForSession = (sessionId: string, serverId: string) => {
  let set = sessionApprovedServers.get(sessionId)
  if (!set) {
    set = new Set()
    sessionApprovedServers.set(sessionId, set)
  }
  set.add(serverId)
}

export const clearSessionToolApprovals = (sessionId: string) => {
  sessionApprovedServers.delete(sessionId)
  const matching = useToolConfirmations.getState().queue.filter((item) => item.sessionId === sessionId)
  for (const item of matching) {
    const resolve = resolvers.get(item.id)
    resolvers.delete(item.id)
    resolve?.('deny')
  }
  if (matching.length > 0) {
    useToolConfirmations.setState((state) => ({
      queue: state.queue.filter((item) => item.sessionId !== sessionId),
    }))
  }
}

export const clearAllToolApprovals = () => {
  sessionApprovedServers.clear()
  const items = useToolConfirmations.getState().queue
  for (const item of items) {
    const resolve = resolvers.get(item.id)
    resolvers.delete(item.id)
    resolve?.('deny')
  }
  useToolConfirmations.setState({ queue: [] })
}

export const resolveToolConfirmation = (id: string, decision: ToolConfirmationDecision) => {
  const item = useToolConfirmations.getState().queue.find((entry) => entry.id === id)
  if (!item) {
    return
  }
  removeFromQueue(id)
  const resolve = resolvers.get(id)
  resolvers.delete(id)

  if (decision === 'deny') {
    resolve?.('deny')
    return
  }

  resolve?.('allow')

  if (decision === 'allow_session' && item.serverId) {
    approveServerForSession(item.sessionId, item.serverId)
    const siblingIds = useToolConfirmations
      .getState()
      .queue.filter(
        (entry) => entry.sessionId === item.sessionId && entry.serverId === item.serverId
      )
      .map((entry) => entry.id)
    for (const siblingId of siblingIds) {
      removeFromQueue(siblingId)
      const siblingResolve = resolvers.get(siblingId)
      resolvers.delete(siblingId)
      siblingResolve?.('allow')
    }
  }
}

export const requestToolConfirmation = ({
  sessionId,
  callId,
  tool,
  input,
  signal,
  onAwaiting,
}: {
  sessionId: string
  callId: string
  tool: ClientToolDefinition
  input: Record<string, unknown>
  signal: AbortSignal
  onAwaiting?: () => void
}): Promise<'allow' | 'deny'> => {
  if (tool.source !== 'mcp' || tool.autoApprove) {
    return Promise.resolve('allow')
  }
  if (tool.serverId && isServerApprovedForSession(sessionId, tool.serverId)) {
    return Promise.resolve('allow')
  }
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    )
  }

  onAwaiting?.()
  const id = createId()
  const entry: PendingToolConfirmation = {
    id,
    sessionId,
    callId,
    toolName: tool.name,
    displayName: tool.displayName || tool.name,
    serverId: tool.serverId,
    serverName: tool.serverName,
    input,
    createdAt: Date.now(),
  }

  return new Promise<'allow' | 'deny'>((resolve, reject) => {
    const onAbort = () => {
      resolvers.delete(id)
      removeFromQueue(id)
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    resolvers.set(id, (result) => {
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    })
    signal.addEventListener('abort', onAbort, { once: true })
    useToolConfirmations.setState((state) => ({ queue: [...state.queue, entry] }))
  })
}
