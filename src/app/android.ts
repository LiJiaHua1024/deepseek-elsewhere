import { readBlobChunks } from '../utils/blob.js'
import { createId } from '../utils/id.js'

type AndroidBridge = {
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
  beginChatRequest: (endpoint: string, format: string, body: string) => string | null
  cancelChatRequest: (id: string) => void
  beginHttpRequest?: (requestId: string, payload: string) => boolean
  cancelHttpRequest?: (requestId: string) => void
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
}

export const android =
  typeof window === 'undefined'
    ? undefined
    : (window as Window & { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid

export type NativeHttpRequestOptions = {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export type NativeHttpResponse = {
  ok: boolean
  status: number
  contentType: string
  text: string
  truncated?: boolean
  error?: string
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
  if (!device?.beginImageSave(name, blob.type)) {
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
