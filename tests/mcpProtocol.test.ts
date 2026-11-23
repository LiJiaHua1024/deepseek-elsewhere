import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { NativeHttpRequestOptions, NativeHttpResponse, NativeHttpStreamResponse } from '../src/app/android.js'
import { buildMcpRegisteredToolName } from '../src/elsewhere/mcp/config.js'
import {
  createMcpClient,
  formatMcpToolResult,
  MCP_MAX_RESULT_CHARS,
} from '../src/elsewhere/mcp/protocol.js'
import type { McpServerConfig } from '../src/elsewhere/mcp/types.js'
import type { HttpStreamTransport, HttpTransport } from '../src/elsewhere/search/http.js'

const encoder = new TextEncoder()

const makeServer = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: 'srv-1',
  name: 'Docs',
  url: 'https://mcp.example.com/service',
  auth: { type: 'none' },
  enabled: true,
  autoApprove: false,
  disabledTools: [],
  cachedTools: [],
  ...overrides,
})

const streamFromText = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (text) {
        controller.enqueue(encoder.encode(text))
      }
      controller.close()
    },
  })

describe('MCP protocol client', () => {
  it('completes Streamable HTTP handshake, maintains Mcp-Session-Id, paginates tools, and sends DELETE on terminate', async () => {
    const requests: { method: string; session?: string; body?: Record<string, unknown> }[] = []

    const httpStream: HttpStreamTransport = (options) => {
      const parsedBody = options.body ? (JSON.parse(options.body) as Record<string, unknown>) : {}
      const methodName = typeof parsedBody.method === 'string' ? parsedBody.method : ''
      const session = options.headers?.['Mcp-Session-Id']
      requests.push({ method: methodName, session, body: parsedBody })

      let payload = '{}'
      const respHeaders: Record<string, string> = { 'content-type': 'application/json' }
      if (methodName === 'initialize') {
        respHeaders['mcp-session-id'] = 'sess-abc'
        payload = JSON.stringify({
          jsonrpc: '2.0',
          id: parsedBody.id,
          result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'demo' } },
        })
      } else if (methodName === 'notifications/initialized') {
        return {
          response: Promise.resolve({
            ok: true,
            status: 202,
            contentType: 'application/json',
            headers: respHeaders,
            body: null,
          }),
          close: () => {},
        }
      } else if (methodName === 'tools/list') {
        const params = parsedBody.params as { cursor?: string } | undefined
        if (!params?.cursor) {
          payload = JSON.stringify({
            jsonrpc: '2.0',
            id: parsedBody.id,
            result: {
              tools: [{ name: 'search', description: 'Search docs', inputSchema: { type: 'object' } }],
              nextCursor: 'page-2',
            },
          })
        } else {
          payload = JSON.stringify({
            jsonrpc: '2.0',
            id: parsedBody.id,
            result: {
              tools: [{ name: 'read', description: 'Read page' }],
            },
          })
        }
      }

      return {
        response: Promise.resolve({
          ok: true,
          status: 200,
          contentType: 'application/json',
          headers: respHeaders,
          body: streamFromText(payload),
        }),
        close: () => {},
      }
    }

    const deleteCalls: NativeHttpRequestOptions[] = []
    const httpRequest: HttpTransport = async (options) => {
      deleteCalls.push(options)
      return { ok: true, status: 204, contentType: '', text: '' }
    }

    const client = createMcpClient({ httpRequest, httpStream })
    const server = makeServer()
    const { tools, mode } = await client.connectAndListTools(server, new AbortController().signal)

    assert.equal(mode, 'streamable')
    assert.deepEqual(
      tools.map((t) => t.name),
      ['search', 'read']
    )
    assert.equal(requests[1].session, 'sess-abc')
    assert.equal(requests[2].session, 'sess-abc')
    assert.equal(requests[3].session, 'sess-abc')

    await client.terminateSession(server)
    assert.equal(deleteCalls.length, 1)
    assert.equal(deleteCalls[0].method, 'DELETE')
    assert.equal(deleteCalls[0].headers?.['Mcp-Session-Id'], 'sess-abc')
  })

  it('resolves Streamable HTTP SSE immediately on matching JSON-RPC id and closes stream without waiting for EOF', async () => {
    let closedCount = 0

    const httpStream: HttpStreamTransport = (options) => {
      const parsedBody = options.body ? (JSON.parse(options.body) as Record<string, unknown>) : {}
      const methodName = typeof parsedBody.method === 'string' ? parsedBody.method : ''

      if (methodName === 'notifications/initialized') {
        return {
          response: Promise.resolve({
            ok: true,
            status: 202,
            contentType: '',
            headers: {},
            body: null,
          }),
          close: () => {},
        }
      }

      let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
      const close = () => {
        closedCount += 1
        try {
          controllerRef?.close()
        } catch {
          // already closed
        }
      }

      // Intentionally NEVER calls controller.close() unless close() is called by the client!
      const body = new ReadableStream<Uint8Array>({
        start: (controller) => {
          controllerRef = controller
          if (methodName === 'initialize') {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: '2.0',
                  id: parsedBody.id,
                  result: { protocolVersion: '2025-03-26', capabilities: {} },
                })}\n\n`
              )
            )
          } else if (methodName === 'tools/call') {
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`
              )
            )
            controller.enqueue(
              encoder.encode(
                `event: message\ndata: ${JSON.stringify({
                  jsonrpc: '2.0',
                  id: parsedBody.id,
                  result: { content: [{ type: 'text', text: 'Instant SSE result' }] },
                })}\n\n`
              )
            )
          }
        },
      })

      return {
        response: Promise.resolve({
          ok: true,
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'sse-stream-1' },
          body,
        }),
        close,
      }
    }

    const client = createMcpClient({ httpStream })
    const server = makeServer()
    const result = await client.callTool(
      server,
      'any_search',
      { query: 'vitest' },
      new AbortController().signal
    )

    assert.equal(result.content, 'Instant SSE result')
    assert.ok(closedCount >= 2, 'Expected stream handle.close() after both initialize and tools/call frames')
  })

  it('re-initializes automatically when Streamable HTTP returns 404 for expired Mcp-Session-Id', async () => {
    let initCount = 0
    let expiredOnce = false

    const httpStream: HttpStreamTransport = (options) => {
      const parsedBody = options.body ? (JSON.parse(options.body) as Record<string, unknown>) : {}
      const methodName = typeof parsedBody.method === 'string' ? parsedBody.method : ''
      const session = options.headers?.['Mcp-Session-Id']

      if (methodName === 'initialize') {
        initCount += 1
        const sid = `sess-${initCount}`
        return {
          response: Promise.resolve({
            ok: true,
            status: 200,
            contentType: 'application/json',
            headers: { 'mcp-session-id': sid },
            body: streamFromText(JSON.stringify({ jsonrpc: '2.0', id: parsedBody.id, result: {} })),
          }),
          close: () => {},
        }
      }
      if (methodName === 'notifications/initialized') {
        return {
          response: Promise.resolve({ ok: true, status: 202, contentType: '', headers: {}, body: null }),
          close: () => {},
        }
      }
      if (methodName === 'tools/call' && session === 'sess-1' && !expiredOnce) {
        expiredOnce = true
        return {
          response: Promise.resolve({
            ok: false,
            status: 404,
            contentType: 'text/plain',
            headers: {},
            body: streamFromText('Session expired'),
          }),
          close: () => {},
        }
      }
      return {
        response: Promise.resolve({
          ok: true,
          status: 200,
          contentType: 'application/json',
          headers: {},
          body: streamFromText(
            JSON.stringify({
              jsonrpc: '2.0',
              id: parsedBody.id,
              result: { content: [{ type: 'text', text: `ok-with-${session}` }] },
            })
          ),
        }),
        close: () => {},
      }
    }

    const client = createMcpClient({ httpStream })
    const server = makeServer()
    const res = await client.callTool(server, 'ping', {}, new AbortController().signal)
    assert.equal(initCount, 2)
    assert.equal(res.content, 'ok-with-sess-2')
  })

  it('falls back to legacy HTTP+SSE on 405, caches transport mode, and closes idle legacy streams', async () => {
    let postInitAttempts = 0
    let sseGetCount = 0
    let sseClosed = false
    let sseController: ReadableStreamDefaultController<Uint8Array> | null = null

    const httpStream: HttpStreamTransport = (options) => {
      if ((options.method ?? 'GET') === 'POST') {
        postInitAttempts += 1
        return {
          response: Promise.resolve({
            ok: false,
            status: 405,
            contentType: 'text/plain',
            headers: {},
            body: streamFromText('Method Not Allowed'),
          }),
          close: () => {},
        }
      }
      sseGetCount += 1
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          sseController = controller
          controller.enqueue(encoder.encode('event: endpoint\ndata: /messages?session=legacy-1\n\n'))
        },
      })
      return {
        response: Promise.resolve({
          ok: true,
          status: 200,
          contentType: 'text/event-stream',
          headers: { 'content-type': 'text/event-stream' },
          body: stream,
        }),
        close: () => {
          sseClosed = true
          try {
            sseController?.close()
          } catch {
            // closed
          }
        },
      }
    }

    const postedUrls: string[] = []
    const httpRequest: HttpTransport = async (options): Promise<NativeHttpResponse> => {
      postedUrls.push(options.url)
      const body = options.body ? (JSON.parse(options.body) as { id?: string; method?: string }) : {}
      if (body.id) {
        const result =
          body.method === 'initialize'
            ? { protocolVersion: '2025-03-26', capabilities: {} }
            : body.method === 'tools/list'
              ? { tools: [{ name: 'legacy_tool', description: 'Legacy' }] }
              : { content: [{ type: 'text', text: 'legacy-done' }] }
        queueMicrotask(() => {
          sseController?.enqueue(
            encoder.encode(
              `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`
            )
          )
        })
      }
      return { ok: true, status: 202, contentType: '', text: '' }
    }

    const client = createMcpClient({ httpRequest, httpStream })
    const server = makeServer()
    const listOutcome = await client.connectAndListTools(server, new AbortController().signal)
    assert.equal(listOutcome.mode, 'legacy-sse')
    assert.equal(listOutcome.tools[0]?.name, 'legacy_tool')
    assert.equal(postedUrls[0], 'https://mcp.example.com/messages?session=legacy-1')

    client.closeAllLegacyStreams()
    assert.equal(sseClosed, true)

    // Subsequent call should remember legacy-sse and skip another POST 405 probe
    sseClosed = false
    const callOutcome = await client.callTool(server, 'legacy_tool', {}, new AbortController().signal)
    assert.equal(callOutcome.content, 'legacy-done')
    assert.equal(postInitAttempts, 1)
    assert.equal(sseGetCount, 2)
    client.closeAllLegacyStreams()
    assert.equal(sseClosed, true)
  })
})

describe('MCP naming & result formatting', () => {
  it('sanitizes tool names, avoids collisions, and enforces 64-char limit', () => {
    const used = new Set<string>(['web_search', 'mcp__Alpha_Server__do_thing'])
    const srv = makeServer({ id: 's1', name: 'Alpha Server!' })

    const n1 = buildMcpRegisteredToolName(srv, 'do thing', used)
    assert.notEqual(n1, 'mcp__Alpha_Server__do_thing')
    assert.ok(n1.length <= 64)
    assert.match(n1, /^[a-zA-Z0-9_-]+$/)

    const longTool = buildMcpRegisteredToolName(
      srv,
      'extremely_long_tool_name_that_exceeds_sixty_four_characters_by_a_huge_margin',
      used
    )
    assert.ok(longTool.length <= 64)
  })

  it('omits binary image/audio payloads and truncates outputs over 16,000 chars', () => {
    const formatted = formatMcpToolResult({
      isError: false,
      content: [
        { type: 'text', text: 'First paragraph' },
        { type: 'image', data: 'QUJDRA==', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'file:///a.txt', text: 'hello' } },
      ],
    })
    assert.match(formatted.content, /First paragraph/)
    assert.match(formatted.content, /\[Image content omitted \(image\/png\)\]/)
    assert.doesNotMatch(formatted.content, /QUJDRA==/)
    assert.match(formatted.content, /\[Resource file:\/\/\/a\.txt\]/)

    const longRes = formatMcpToolResult({
      content: [{ type: 'text', text: 'x'.repeat(MCP_MAX_RESULT_CHARS + 500) }],
    })
    assert.equal(longRes.meta?.kind, 'generic')
    assert.equal(longRes.meta?.kind === 'generic' && longRes.meta.truncated, true)
    assert.ok(longRes.content.includes(`[Truncated: showing first ${MCP_MAX_RESULT_CHARS}`))
  })
})
