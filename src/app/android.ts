import { readBlobChunks } from '../utils/blob.js'
import { createId } from '../utils/id.js'

export type AndroidBridge = {
  statusInset: () => number
  buttonNavigationInset: () => number
  systemFontScale: () => number
  openAppPermissions: () => void
  updateStatus: () => string
  checkForUpdate: () => void
  installUpdate: () => void
  getMusicVolume?: () => number
  openSourcePage: (
    url: string,
    dark: boolean,
    closeLabel: string,
    browserLabel: string,
    loadingLabel: string,
    errorLabel: string,
    retryLabel: string
  ) => void
  readApiKey: () => string | null
  writeApiKey: (value: string | null) => boolean
  readChatConfig: () => string | null
  writeChatConfig: (value: string | null) => boolean
  readProviderSecrets?: () => string | null
  writeProviderSecrets?: (value: string | null) => boolean
  beginChatRequest: (endpoint: string, format: string, body: string) => string | null
  cancelChatRequest: (id: string) => void
  beginHttpRequest?: (requestId: string, payload: string) => boolean
  cancelHttpRequest?: (requestId: string) => void
  beginHttpStream?: (streamId: string, payload: string) => boolean
  cancelHttpStream?: (streamId: string) => void
  getPyodideStatus?: () => string
  beginPyodideDownload?: () => void
  cancelPyodideDownload?: () => void
  clearPyodideCache?: () => boolean
  ensurePyodideFiles?: (requestId: string, filesJsonArray: string) => boolean
  cancelPyodideFiles?: (requestId: string) => void
  requestOfficialBalance?: (requestId: string) => void
  readAccountProfile: () => string | null
  writeAccountProfile: (value: string | null) => boolean
  setDarkBars: (dark: boolean) => void
  setHandlesBack: (handlesBack: boolean) => void
  setBackPreviewEnabled: (enabled: boolean) => void
  setImageViewerFullscreen: (fullscreen: boolean) => void
  requestRecentPhotos: () => void
  prefetchRecentPhotos: () => void
  requestHistoryExport: (name: string) => void
  writeHistoryExport: (bytes: string) => boolean
  finishHistoryExport: () => boolean
  chatStorage?: (method: string, payload: string) => string
  shadowList?: (dir: 'sessions' | 'files') => string | null
  shadowReadChunk?: (path: string, offset: number) => string | null
  shadowClearAll?: () => boolean
  requestImageSavePermission?: () => void
  beginImageSave: (name: string, mime: string) => boolean
  writeImageSave: (bytes: string) => boolean
  finishImageSave: (keep: boolean) => boolean
  requestRecording: () => void
  finishRecording: (keep: boolean) => boolean
  recordingLevel: () => number
  setSelectionExclusion?: (
    startLeft: number,
    startTop: number,
    startRight: number,
    startBottom: number,
    endLeft: number,
    endTop: number,
    endRight: number,
    endBottom: number,
    active: boolean
  ) => void
  syncKeepAlive?: (payloadJson: string) => void
  notifyBackgroundEvent?: (payloadJson: string) => void
  clearSessionNotification?: (sessionId: string) => void
  requestNotificationPermission?: () => void
  areNotificationsEnabled?: () => boolean
  isIgnoringBatteryOptimizations?: () => boolean
  openBatteryOptimizationSettings?: () => void
}

export const android =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid

export type NativeHttpRequestOptions = {
  url: string
  method?: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export type NativeHttpResponse = {
  ok: boolean
  status: number
  contentType: string
  headers?: Record<string, string>
  text: string
  truncated?: boolean
  error?: string
}

export type NativeHttpStreamResponse = {
  ok: boolean
  status: number
  contentType: string
  headers: Record<string, string>
  body: ReadableStream<Uint8Array> | null
}

export type NativePyodideStatus = {
  version: string
  installed: boolean
  downloading: boolean
  progress: number
  downloadedBytes: number
  totalBytes: number
  cachedBytes: number
  error: string
}

const normalizeResponseHeaders = (raw: unknown): Record<string, string> => {
  if (!raw || typeof raw !== 'object') {
    return {}
  }
  const normalized: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      normalized[key.toLowerCase()] = value
    }
  }
  return normalized
}

export const httpRequest = (
  options: NativeHttpRequestOptions,
  signal?: AbortSignal
): Promise<NativeHttpResponse> => {
  const device = android
  if (!device?.beginHttpRequest) {
    return Promise.reject(new Error('Android HTTP bridge is unavailable'))
  }
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
  }
  const requestId = createId()
  return new Promise<NativeHttpResponse>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('android-http-response', onResponse)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      device.cancelHttpRequest?.(requestId)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const onResponse = (event: Event) => {
      const detail = (event as CustomEvent<NativeHttpResponse & { id?: string }>).detail
      if (detail?.id !== requestId) {
        return
      }
      cleanup()
      resolve({
        ok: Boolean(detail.ok),
        status: typeof detail.status === 'number' ? detail.status : 0,
        contentType: typeof detail.contentType === 'string' ? detail.contentType : '',
        headers: normalizeResponseHeaders(detail.headers),
        text: typeof detail.text === 'string' ? detail.text : '',
        truncated: Boolean(detail.truncated),
        ...(typeof detail.error === 'string' && detail.error ? { error: detail.error } : {}),
      })
    }
    window.addEventListener('android-http-response', onResponse)
    signal?.addEventListener('abort', onAbort, { once: true })
    const started = device.beginHttpRequest?.(requestId, JSON.stringify(options))
    if (!started) {
      cleanup()
      reject(new Error('Unable to start Android HTTP request'))
    }
  })
}

type NativeHttpStreamEvent = { id?: string } & (
  | { type: 'headers'; status: number; contentType?: string; headers?: Record<string, string> }
  | { type: 'data'; bytes: string }
  | { type: 'end' }
  | { type: 'error'; message?: string }
)

export const httpStream = (
  options: NativeHttpRequestOptions,
  signal?: AbortSignal
): { response: Promise<NativeHttpStreamResponse>; close: () => void } => {
  const device = android
  if (!device?.beginHttpStream) {
    return {
      response: Promise.reject(new Error('Android HTTP stream bridge is unavailable')),
      close: () => {},
    }
  }
  if (signal?.aborted) {
    return {
      response: Promise.reject(
        signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      ),
      close: () => {},
    }
  }

  let activeId: string | null = createId()
  let headersReceived = false
  let settled = false
  let receiver: ReadableStreamDefaultController<Uint8Array> | null = null
  let resolvePromise: (res: NativeHttpStreamResponse) => void = () => {}
  let rejectPromise: (err: unknown) => void = () => {}

  const response = new Promise<NativeHttpStreamResponse>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })

  const close = () => {
    window.removeEventListener('android-http-stream', onEvent)
    signal?.removeEventListener('abort', onAbort)
    if (activeId) {
      const idToCancel = activeId
      activeId = null
      device.cancelHttpStream?.(idToCancel)
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start: (controller) => {
      receiver = controller
    },
    cancel: () => {
      close()
    },
  })

  const fail = (error: unknown) => {
    if (settled && !headersReceived) {
      return
    }
    close()
    if (headersReceived) {
      try {
        receiver?.error(error)
      } catch {
        // Stream may already be closed
      }
    } else if (!settled) {
      settled = true
      rejectPromise(error)
    }
  }

  const onAbort = () =>
    fail(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))

  const onEvent = (event: Event) => {
    const detail = (event as CustomEvent<NativeHttpStreamEvent>).detail
    if (!detail || !activeId || detail.id !== activeId) {
      return
    }
    switch (detail.type) {
      case 'headers': {
        headersReceived = true
        settled = true
        const headers = normalizeResponseHeaders(detail.headers)
        const contentType =
          typeof detail.contentType === 'string'
            ? detail.contentType
            : (headers['content-type'] ?? '')
        const status = typeof detail.status === 'number' ? detail.status : 0
        const hasNoBody = status === 204 || status === 205
        resolvePromise({
          ok: status >= 200 && status < 300,
          status,
          contentType,
          headers,
          body: hasNoBody ? null : stream,
        })
        if (hasNoBody) {
          close()
        }
        break
      }
      case 'data': {
        if (!detail.bytes || !receiver) {
          return
        }
        const binary = atob(detail.bytes)
        const chunk = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i += 1) {
          chunk[i] = binary.charCodeAt(i)
        }
        receiver.enqueue(chunk)
        break
      }
      case 'end': {
        close()
        try {
          receiver?.close()
        } catch {
          // Stream already closed
        }
        break
      }
      case 'error': {
        fail(new Error(detail.message || 'HTTP stream failed'))
        break
      }
    }
  }

  window.addEventListener('android-http-stream', onEvent)
  signal?.addEventListener('abort', onAbort, { once: true })
  const started = device.beginHttpStream(activeId, JSON.stringify(options))
  if (!started) {
    fail(new Error('Unable to start Android HTTP stream'))
  }
  return { response, close }
}

export const ensureAndroidPyodideFiles = (
  files: readonly string[],
  signal?: AbortSignal
): Promise<void> => {
  const device = android
  if (!device?.ensurePyodideFiles) {
    return Promise.resolve()
  }
  if (files.length === 0) {
    return Promise.resolve()
  }
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    )
  }
  const requestId = createId()
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener('android-pyodide-files', onDone)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      device.cancelPyodideFiles?.(requestId)
      reject(signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const onDone = (event: Event) => {
      const detail = (event as CustomEvent<{ id?: string; ok?: boolean; error?: string }>).detail
      if (detail?.id !== requestId) {
        return
      }
      cleanup()
      if (detail.ok) {
        resolve()
      } else {
        reject(new Error(detail.error || 'Failed to download Python package'))
      }
    }
    window.addEventListener('android-pyodide-files', onDone)
    signal?.addEventListener('abort', onAbort, { once: true })
    const started = device.ensurePyodideFiles?.(requestId, JSON.stringify(files))
    if (!started) {
      cleanup()
      reject(new Error('Unable to start Python package download'))
    }
  })
}

const writeAndroidBlob = async (blob: Blob, append: (base64: string) => boolean) => {
  const chunkSize = 32768
  for await (const chunk of readBlobChunks(blob)) {
    for (let offset = 0; offset < chunk.length; offset += chunkSize) {
      const base64 = btoa(String.fromCharCode(...chunk.subarray(offset, offset + chunkSize)))
      if (!append(base64)) {
        throw new Error('Unable to write the file')
      }
    }
  }
}

export const saveAndroidHistory = async (name: string, blob: Blob): Promise<boolean> => {
  const device = android
  if (!device) {
    return false
  }
  const status = await new Promise<string>((resolve) => {
    window.addEventListener(
      'android-export',
      (event) => resolve((event as CustomEvent<string>).detail),
      { once: true }
    )
    device.requestHistoryExport(name)
  })
  if (status === 'cancelled') {
    return false
  }
  if (status !== 'ready') {
    throw new Error('Unable to open the export document')
  }
  let closed = false
  try {
    await writeAndroidBlob(blob, (base64) => device.writeHistoryExport(base64))
    closed = device.finishHistoryExport()
    if (!closed) {
      throw new Error('Unable to close the export document')
    }
    return true
  } finally {
    if (!closed) {
      device.finishHistoryExport()
    }
  }
}

export const saveAndroidImage = async (name: string, blob: Blob) => {
  const device = android
  if (!device) {
    throw new Error('Unable to create the image')
  }
  if (device.requestImageSavePermission) {
    const status = await new Promise<string>((resolve) => {
      window.addEventListener(
        'android-image-save-permission',
        (event) => resolve((event as CustomEvent<string>).detail),
        { once: true }
      )
      device.requestImageSavePermission?.()
    })
    if (status !== 'granted') {
      throw new Error('Permission denied')
    }
  }
  if (!device.beginImageSave(name, blob.type)) {
    throw new Error('Unable to create the image')
  }
  try {
    await writeAndroidBlob(blob, (base64) => device.writeImageSave(base64))
  } catch (error) {
    device.finishImageSave(false)
    throw error
  }
  if (!device.finishImageSave(true)) {
    throw new Error('Unable to save the image')
  }
}
