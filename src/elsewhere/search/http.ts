import {
  android,
  httpRequest,
  httpStream,
  type NativeHttpRequestOptions,
  type NativeHttpResponse,
  type NativeHttpStreamResponse,
} from '../../app/android.js'

export type HttpTransport = (
  options: NativeHttpRequestOptions,
  signal?: AbortSignal
) => Promise<NativeHttpResponse>

export type HttpStreamHandle = {
  response: Promise<NativeHttpStreamResponse>
  close: () => void
}

export type HttpStreamTransport = (
  options: NativeHttpRequestOptions,
  signal?: AbortSignal
) => HttpStreamHandle

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000

const createAbortError = () => new DOMException('The operation was aborted.', 'AbortError')

const toLowerHeaders = (headers: Headers): Record<string, string> => {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

export const createTimeoutSignal = (
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; cleanup: () => void; didTimeout: () => boolean } => {
  const controller = new AbortController()
  let timedOut = false
  const onParentAbort = () => {
    controller.abort(parent?.reason ?? createAbortError())
  }
  if (parent?.aborted) {
    controller.abort(parent.reason ?? createAbortError())
    return {
      signal: controller.signal,
      cleanup: () => {},
      didTimeout: () => false,
    }
  }
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
  }, timeoutMs)
  parent?.addEventListener('abort', onParentAbort, { once: true })
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
    didTimeout: () => timedOut,
  }
}

export const performHttpRequest: HttpTransport = async (options, signal) => {
  if (signal?.aborted) {
    throw signal.reason ?? createAbortError()
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS
  if (android?.beginHttpRequest) {
    return httpRequest({ ...options, timeoutMs }, signal)
  }
  const timeout = createTimeoutSignal(signal, timeoutMs)
  try {
    const method = options.method ?? 'GET'
    const response = await fetch(options.url, {
      method,
      headers: options.headers,
      body: method === 'POST' || (method === 'DELETE' && options.body) ? options.body : undefined,
      signal: timeout.signal,
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('Content-Type') ?? '',
      headers: toLowerHeaders(response.headers),
      text,
    }
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason ?? error
    }
    return {
      ok: false,
      status: 0,
      contentType: '',
      text: '',
      error: timeout.didTimeout()
        ? 'Request timed out'
        : error instanceof Error
          ? error.message
          : String(error),
    }
  } finally {
    timeout.cleanup()
  }
}

export const performHttpStream: HttpStreamTransport = (options, signal) => {
  if (signal?.aborted) {
    return {
      response: Promise.reject(signal.reason ?? createAbortError()),
      close: () => {},
    }
  }
  const timeoutMs = options.timeoutMs ?? 60_000
  if (android?.beginHttpStream) {
    const timeout = createTimeoutSignal(signal, timeoutMs)
    const handle = httpStream({ ...options, timeoutMs }, timeout.signal)
    const cleanup = () => timeout.cleanup()
    return {
      response: handle.response.catch((error) => {
        cleanup()
        if (!signal?.aborted && timeout.didTimeout()) {
          throw new DOMException('Request timed out', 'TimeoutError')
        }
        throw error
      }),
      close: () => {
        cleanup()
        handle.close()
      },
    }
  }

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('Request timed out', 'TimeoutError'))
  }, timeoutMs)
  const onParentAbort = () => {
    controller.abort(signal?.reason ?? createAbortError())
  }
  signal?.addEventListener('abort', onParentAbort, { once: true })

  let closed = false
  const close = () => {
    if (closed) {
      return
    }
    closed = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onParentAbort)
    controller.abort(createAbortError())
  }

  const method = options.method ?? 'GET'
  const response = fetch(options.url, {
    method,
    headers: options.headers,
    body: method === 'POST' || (method === 'DELETE' && options.body) ? options.body : undefined,
    signal: controller.signal,
  })
    .then(
      (res): NativeHttpStreamResponse => ({
        ok: res.ok,
        status: res.status,
        contentType: res.headers.get('Content-Type') ?? '',
        headers: toLowerHeaders(res.headers),
        body: res.body,
      })
    )
    .catch((error: unknown) => {
      close()
      if (!signal?.aborted && timedOut) {
        throw new DOMException('Request timed out', 'TimeoutError')
      }
      throw error
    })

  return { response, close }
}
