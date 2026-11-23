import { readServerSentEvents } from '../../services/api/sse.js'
import { createId } from '../../utils/id.js'
import {
  performHttpRequest,
  performHttpStream,
  type HttpStreamTransport,
  type HttpTransport,
} from '../search/http.js'
import type { ToolExecutionResult } from '../tools/types.js'
import { buildMcpAuthHeaders, normalizeMcpInputSchema } from './config.js'
import type { McpCachedTool, McpServerConfig, McpTransportMode } from './types.js'

export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const MCP_TOOL_TIMEOUT_MS = 60_000
export const MCP_HANDSHAKE_TIMEOUT_MS = 20_000
export const MCP_MAX_RESULT_CHARS = 16_000
const MAX_TOOLS_PAGES = 50

const CLIENT_INFO = { name: 'Elsewhere', version: '0.2.0' }

type JsonRpcErrorObject = {
  code?: number
  message?: string
  data?: unknown
}

type JsonRpcMessage = {
  jsonrpc?: string
  id?: string | number | null
  result?: unknown
  error?: JsonRpcErrorObject
}

type StreamableRuntime = {
  mode: 'streamable'
  signature: string
  sessionId?: string
}

type LegacyPendingRpc = {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

type LegacySseSession = {
  mode: 'legacy-sse'
  signature: string
  messageUrl: string
  pending: Map<string, LegacyPendingRpc>
  closed: boolean
  close: () => void
  ready: Promise<void>
}

type RuntimeEntry = StreamableRuntime | LegacySseSession

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly nonJsonRpc = false
  ) {
    super(message)
    this.name = 'HttpStatusError'
  }
}

class JsonRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string
  ) {
    super(message)
    this.name = 'JsonRpcError'
  }
}

const serverSignature = (server: Pick<McpServerConfig, 'url' | 'auth'>): string =>
  `${server.url}|${JSON.stringify(server.auth)}`

const parseJsonSafe = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

const isJsonRpcResponseFor = (value: unknown, expectedId: string): value is JsonRpcMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const msg = value as JsonRpcMessage
  if (String(msg.id ?? '') !== expectedId) {
    return false
  }
  return 'result' in msg || 'error' in msg
}

const extractRpcOutcome = (msg: JsonRpcMessage): unknown => {
  if (msg.error) {
    throw new JsonRpcError(
      typeof msg.error.code === 'number' ? msg.error.code : undefined,
      typeof msg.error.message === 'string' && msg.error.message
        ? msg.error.message
        : 'MCP tool error'
    )
  }
  return msg.result
}

const readAllStreamText = async (
  body: ReadableStream<Uint8Array> | null,
  signal: AbortSignal
): Promise<string> => {
  if (!body) {
    return ''
  }
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const onAbort = () => {
    reader.cancel(signal.reason).catch(() => {})
  }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        text += decoder.decode()
        return text
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
}

export const formatMcpToolResult = (rawResult: unknown): ToolExecutionResult => {
  if (!rawResult || typeof rawResult !== 'object') {
    return { content: String(rawResult ?? '') }
  }
  const record = rawResult as Record<string, unknown>
  const isError = record.isError === true
  const parts: string[] = []

  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue
      }
      const item = block as Record<string, unknown>
      const type = typeof item.type === 'string' ? item.type : ''
      if (type === 'text' && typeof item.text === 'string') {
        parts.push(item.text)
      } else if (type === 'resource' && item.resource && typeof item.resource === 'object') {
        const res = item.resource as Record<string, unknown>
        const uri = typeof res.uri === 'string' ? res.uri : ''
        const mime = typeof res.mimeType === 'string' ? res.mimeType : ''
        if (typeof res.text === 'string') {
          parts.push(uri ? `[Resource ${uri}]\n${res.text}` : res.text)
        } else {
          parts.push(
            `[Binary resource${mime ? `: ${mime}` : ''}${uri ? ` (${uri})` : ''}]`
          )
        }
      } else if (type === 'image') {
        const mime = typeof item.mimeType === 'string' ? item.mimeType : ''
        parts.push(`[Image content omitted${mime ? ` (${mime})` : ''}]`)
      } else if (type === 'audio') {
        const mime = typeof item.mimeType === 'string' ? item.mimeType : ''
        parts.push(`[Audio content omitted${mime ? ` (${mime})` : ''}]`)
      } else if (type === 'resource_link') {
        const label =
          (typeof item.name === 'string' && item.name) ||
          (typeof item.uri === 'string' && item.uri) ||
          'unknown'
        parts.push(`[Resource link: ${label}]`)
      } else if (type) {
        parts.push(`[Unsupported content block: ${type}]`)
      }
    }
  }

  let text = parts.join('\n\n')
  if (!text && record.structuredContent !== undefined) {
    text = JSON.stringify(record.structuredContent)
  }

  const totalChars = text.length
  const truncated = totalChars > MCP_MAX_RESULT_CHARS
  if (truncated) {
    text = `${text.slice(0, MCP_MAX_RESULT_CHARS)}\n\n[Truncated: showing first ${MCP_MAX_RESULT_CHARS} of ${totalChars} chars]`
  }

  return {
    content: text,
    ...(isError ? { isError: true } : {}),
    meta: {
      kind: 'generic',
      ...(truncated ? { truncated: true } : {}),
    },
  }
}

export type McpClientDependencies = {
  httpRequest?: HttpTransport
  httpStream?: HttpStreamTransport
}

export const createMcpClient = (deps: McpClientDependencies = {}) => {
  const sendHttp = deps.httpRequest ?? performHttpRequest
  const sendStream = deps.httpStream ?? performHttpStream
  const runtimes = new Map<string, RuntimeEntry>()
  const cachedModes = new Map<string, { signature: string; mode: McpTransportMode }>()

  const closeRuntime = (serverId: string) => {
    const entry = runtimes.get(serverId)
    if (entry?.mode === 'legacy-sse') {
      entry.close()
    }
    runtimes.delete(serverId)
    cachedModes.delete(serverId)
  }

  const streamableRpc = async (
    server: McpServerConfig,
    sessionId: string | undefined,
    method: string,
    params: Record<string, unknown> | undefined,
    id: string | null,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<{ result: unknown; sessionId?: string }> => {
    const payload =
      id === null
        ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
        : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
      ...buildMcpAuthHeaders(server.auth),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    }

    const handle = sendStream(
      {
        url: server.url,
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        timeoutMs,
      },
      signal
    )

    try {
      const response = await handle.response
      const nextSessionId = response.headers['mcp-session-id'] || sessionId
      const contentType = (response.contentType || response.headers['content-type'] || '').toLowerCase()

      if (id === null) {
        if (!response.ok && response.status !== 202 && response.status !== 204) {
          const errText = await readAllStreamText(response.body, signal).catch(() => '')
          throw new HttpStatusError(
            response.status,
            errText.trim() || `HTTP ${response.status}`,
            true
          )
        }
        return { result: undefined, sessionId: nextSessionId }
      }

      if (!response.ok) {
        const errText = await readAllStreamText(response.body, signal).catch(() => '')
        const parsed = parseJsonSafe(errText)
        if (isJsonRpcResponseFor(parsed, id) && parsed.error) {
          throw new JsonRpcError(parsed.error.code, parsed.error.message || `HTTP ${response.status}`)
        }
        throw new HttpStatusError(
          response.status,
          errText.trim() || `HTTP ${response.status}`,
          true
        )
      }

      if (contentType.includes('text/event-stream')) {
        if (!response.body) {
          throw new HttpStatusError(response.status, 'Empty event stream response', true)
        }
        for await (const frame of readServerSentEvents(response.body, signal)) {
          if (frame.data === '[DONE]') {
            break
          }
          const parsed = parseJsonSafe(frame.data)
          if (Array.isArray(parsed)) {
            const matched = parsed.find((item) => isJsonRpcResponseFor(item, id))
            if (matched) {
              handle.close()
              return { result: extractRpcOutcome(matched), sessionId: nextSessionId }
            }
          } else if (isJsonRpcResponseFor(parsed, id)) {
            handle.close()
            return { result: extractRpcOutcome(parsed), sessionId: nextSessionId }
          }
        }
        throw new Error('SSE stream ended before response was received')
      }

      const text = await readAllStreamText(response.body, signal)
      const parsed = parseJsonSafe(text)
      if (Array.isArray(parsed)) {
        const matched = parsed.find((item) => isJsonRpcResponseFor(item, id))
        if (matched) {
          return { result: extractRpcOutcome(matched), sessionId: nextSessionId }
        }
      } else if (isJsonRpcResponseFor(parsed, id)) {
        return { result: extractRpcOutcome(parsed), sessionId: nextSessionId }
      }
      throw new HttpStatusError(
        response.status,
        text.trim() || 'Invalid MCP JSON response',
        true
      )
    } finally {
      handle.close()
    }
  }

  const initializeStreamable = async (
    server: McpServerConfig,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<StreamableRuntime> => {
    const initId = createId()
    const init = await streamableRpc(
      server,
      undefined,
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      initId,
      signal,
      timeoutMs
    )
    const runtime: StreamableRuntime = {
      mode: 'streamable',
      signature: serverSignature(server),
      sessionId: init.sessionId,
    }
    await streamableRpc(
      server,
      runtime.sessionId,
      'notifications/initialized',
      undefined,
      null,
      signal,
      Math.min(timeoutMs, 10_000)
    ).catch((error: unknown) => {
      if (signal.aborted) {
        throw error
      }
      if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
        throw error
      }
    })
    return runtime
  }

  const sendLegacyPost = async (
    server: McpServerConfig,
    session: LegacySseSession,
    method: string,
    params: Record<string, unknown> | undefined,
    id: string | null,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<unknown> => {
    if (session.closed) {
      throw new Error('Legacy SSE session closed')
    }
    const payload =
      id === null
        ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
        : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }

    const pendingPromise =
      id === null
        ? null
        : new Promise<unknown>((resolve, reject) => {
            session.pending.set(id, { resolve, reject })
          })

    const onAbort = () => {
      if (id !== null) {
        const entry = session.pending.get(id)
        if (entry) {
          session.pending.delete(id)
          entry.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
        }
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await sendHttp(
        {
          url: session.messageUrl,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...buildMcpAuthHeaders(server.auth),
          },
          body: JSON.stringify(payload),
          timeoutMs,
        },
        signal
      )
      if (!response.ok) {
        throw new HttpStatusError(
          response.status,
          response.error || response.text.trim() || `HTTP ${response.status}`,
          true
        )
      }
      if (id === null) {
        return undefined
      }
      const direct = parseJsonSafe(response.text)
      if (isJsonRpcResponseFor(direct, id)) {
        session.pending.delete(id)
        return extractRpcOutcome(direct)
      }
      return await pendingPromise
    } catch (error) {
      if (id !== null) {
        session.pending.delete(id)
      }
      throw error
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  }

  const openLegacySse = async (
    server: McpServerConfig,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<LegacySseSession> => {
    const controller = new AbortController()
    const pending = new Map<string, LegacyPendingRpc>()
    const onParentAbort = () => {
      controller.abort(signal.reason)
    }
    signal.addEventListener('abort', onParentAbort, { once: true })

    const handle = sendStream(
      {
        url: server.url,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          ...buildMcpAuthHeaders(server.auth),
        },
        timeoutMs: 300_000,
      },
      controller.signal
    )

    let endpointResolved = false
    let resolveEndpoint: (url: string) => void = () => {}
    let rejectEndpoint: (err: unknown) => void = () => {}
    const endpointPromise = new Promise<string>((resolve, reject) => {
      resolveEndpoint = resolve
      rejectEndpoint = reject
    })

    const session: LegacySseSession = {
      mode: 'legacy-sse',
      signature: serverSignature(server),
      messageUrl: '',
      pending,
      closed: false,
      close: () => {
        if (session.closed) {
          return
        }
        session.closed = true
        signal.removeEventListener('abort', onParentAbort)
        handle.close()
        controller.abort()
        for (const [reqId, item] of pending) {
          pending.delete(reqId)
          item.reject(new Error('MCP SSE connection closed'))
        }
      },
      ready: Promise.resolve(),
    }

    const endpointTimer = setTimeout(() => {
      if (!endpointResolved) {
        endpointResolved = true
        rejectEndpoint(new Error('Timed out waiting for MCP SSE endpoint'))
        session.close()
      }
    }, Math.min(timeoutMs, MCP_HANDSHAKE_TIMEOUT_MS))

    void (async () => {
      try {
        const res = await handle.response
        if (!res.ok || !res.body) {
          throw new HttpStatusError(res.status, `HTTP ${res.status}`, true)
        }
        const base = new URL(server.url)
        for await (const frame of readServerSentEvents(res.body, controller.signal)) {
          if (session.closed) {
            break
          }
          if (frame.event === 'endpoint' && !endpointResolved) {
            const target = new URL(frame.data.trim(), base)
            if (target.origin !== base.origin) {
              throw new Error('SSE endpoint origin mismatch')
            }
            endpointResolved = true
            clearTimeout(endpointTimer)
            resolveEndpoint(target.toString())
            continue
          }
          const parsed = parseJsonSafe(frame.data)
          const messages = Array.isArray(parsed) ? parsed : [parsed]
          for (const msg of messages) {
            if (!msg || typeof msg !== 'object') {
              continue
            }
            const rpc = msg as JsonRpcMessage
            if (rpc.id === undefined || rpc.id === null) {
              continue
            }
            const waiter = pending.get(String(rpc.id))
            if (waiter) {
              pending.delete(String(rpc.id))
              try {
                waiter.resolve(extractRpcOutcome(rpc))
              } catch (rpcError) {
                waiter.reject(rpcError)
              }
            }
          }
        }
        if (!endpointResolved) {
          throw new Error('MCP SSE stream ended before receiving endpoint')
        }
      } catch (error) {
        clearTimeout(endpointTimer)
        if (!endpointResolved) {
          endpointResolved = true
          rejectEndpoint(error)
        }
      } finally {
        clearTimeout(endpointTimer)
        session.close()
        if (runtimes.get(server.id) === session) {
          runtimes.delete(server.id)
        }
      }
    })()

    try {
      session.messageUrl = await endpointPromise
      signal.removeEventListener('abort', onParentAbort)
      await sendLegacyPost(
        server,
        session,
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        },
        createId(),
        signal,
        timeoutMs
      )
      await sendLegacyPost(
        server,
        session,
        'notifications/initialized',
        undefined,
        null,
        signal,
        Math.min(timeoutMs, 10_000)
      ).catch(() => {})
      return session
    } catch (error) {
      session.close()
      throw error
    }
  }

  const ensureSession = async (
    server: McpServerConfig,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<RuntimeEntry> => {
    const signature = serverSignature(server)
    const existing = runtimes.get(server.id)
    if (existing && existing.signature === signature) {
      if (existing.mode === 'streamable' || !existing.closed) {
        return existing
      }
      runtimes.delete(server.id)
    } else if (existing) {
      closeRuntime(server.id)
    }

    const remembered = cachedModes.get(server.id)
    if (remembered && remembered.signature === signature && remembered.mode === 'legacy-sse') {
      const legacy = await openLegacySse(server, signal, timeoutMs)
      runtimes.set(server.id, legacy)
      return legacy
    }

    try {
      const runtime = await initializeStreamable(server, signal, timeoutMs)
      runtimes.set(server.id, runtime)
      cachedModes.set(server.id, { signature, mode: 'streamable' })
      return runtime
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      if (error instanceof HttpStatusError && (error.status === 401 || error.status === 403)) {
        throw error
      }
      const shouldFallback =
        error instanceof HttpStatusError &&
        (error.status === 404 || error.status === 405 || error.status === 400 || error.status === 415 || error.status === 501 || error.nonJsonRpc)
      if (!shouldFallback) {
        throw error
      }
      const legacy = await openLegacySse(server, signal, timeoutMs)
      runtimes.set(server.id, legacy)
      cachedModes.set(server.id, { signature, mode: 'legacy-sse' })
      return legacy
    }
  }

  const executeRpc = async (
    server: McpServerConfig,
    method: string,
    params: Record<string, unknown> | undefined,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<{ result: unknown; mode: McpTransportMode }> => {
    const entry = await ensureSession(server, signal, timeoutMs)
    const rpcId = createId()
    if (entry.mode === 'legacy-sse') {
      const result = await sendLegacyPost(server, entry, method, params, rpcId, signal, timeoutMs)
      return { result, mode: 'legacy-sse' }
    }

    try {
      const outcome = await streamableRpc(
        server,
        entry.sessionId,
        method,
        params,
        rpcId,
        signal,
        timeoutMs
      )
      entry.sessionId = outcome.sessionId
      return { result: outcome.result, mode: 'streamable' }
    } catch (error) {
      if (
        !signal.aborted &&
        entry.sessionId &&
        error instanceof HttpStatusError &&
        error.status === 404
      ) {
        const refreshed = await initializeStreamable(server, signal, timeoutMs)
        runtimes.set(server.id, refreshed)
        const retried = await streamableRpc(
          server,
          refreshed.sessionId,
          method,
          params,
          createId(),
          signal,
          timeoutMs
        )
        refreshed.sessionId = retried.sessionId
        return { result: retried.result, mode: 'streamable' }
      }
      throw error
    }
  }

  const connectAndListTools = async (
    server: McpServerConfig,
    signal: AbortSignal
  ): Promise<{ tools: McpCachedTool[]; mode: McpTransportMode }> => {
    const tools: McpCachedTool[] = []
    let cursor: string | undefined
    let mode: McpTransportMode = 'streamable'

    for (let page = 0; page < MAX_TOOLS_PAGES; page += 1) {
      const params = cursor ? { cursor } : undefined
      const response = await executeRpc(
        server,
        'tools/list',
        params,
        signal,
        MCP_HANDSHAKE_TIMEOUT_MS
      )
      mode = response.mode
      const body =
        response.result && typeof response.result === 'object'
          ? (response.result as Record<string, unknown>)
          : {}
      const pageTools = Array.isArray(body.tools) ? body.tools : []
      for (const rawTool of pageTools) {
        if (!rawTool || typeof rawTool !== 'object') {
          continue
        }
        const item = rawTool as Record<string, unknown>
        if (typeof item.name !== 'string' || !item.name.trim()) {
          continue
        }
        tools.push({
          name: item.name.trim(),
          description: typeof item.description === 'string' ? item.description : '',
          inputSchema: normalizeMcpInputSchema(item.inputSchema),
        })
      }
      const nextCursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : undefined
      if (!nextCursor || nextCursor === cursor) {
        break
      }
      cursor = nextCursor
    }
    return { tools, mode }
  }

  const callTool = async (
    server: McpServerConfig,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<ToolExecutionResult> => {
    const { result } = await executeRpc(
      server,
      'tools/call',
      { name: toolName, arguments: args },
      signal,
      MCP_TOOL_TIMEOUT_MS
    )
    return formatMcpToolResult(result)
  }

  const terminateSession = async (server: McpServerConfig) => {
    const entry = runtimes.get(server.id)
    const sessionId = entry?.mode === 'streamable' ? entry.sessionId : undefined
    closeRuntime(server.id)
    if (sessionId) {
      await sendHttp({
        url: server.url,
        method: 'DELETE',
        headers: {
          'MCP-Protocol-Version': MCP_PROTOCOL_VERSION,
          'Mcp-Session-Id': sessionId,
          ...buildMcpAuthHeaders(server.auth),
        },
        timeoutMs: 5_000,
      }).catch(() => {})
    }
  }

  const closeAllLegacyStreams = () => {
    for (const [id, entry] of runtimes) {
      if (entry.mode === 'legacy-sse') {
        entry.close()
        runtimes.delete(id)
      }
    }
  }

  return {
    connectAndListTools,
    callTool,
    terminateSession,
    closeRuntime,
    closeAllLegacyStreams,
  }
}

export const mcpClient = createMcpClient()
