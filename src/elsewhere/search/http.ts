import {
  android,
  httpRequest,
  type NativeHttpRequestOptions,
  type NativeHttpResponse,
} from '../../app/android.js'

export type HttpTransport = (
  options: NativeHttpRequestOptions,
  signal?: AbortSignal
) => Promise<NativeHttpResponse>

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000

const createAbortError = () => new DOMException('The operation was aborted.', 'AbortError')

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
    const response = await fetch(options.url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.method === 'POST' ? options.body : undefined,
      signal: timeout.signal,
    })
    const text = await response.text()
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get('Content-Type') ?? '',
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
