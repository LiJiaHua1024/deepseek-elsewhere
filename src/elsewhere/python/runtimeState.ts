import { create } from 'zustand'
import { android, type NativePyodideStatus } from '../../app/android.js'
import { PYODIDE_VERSION, setPythonEnabled } from './config.js'

export type PyodideRuntimeState = NativePyodideStatus & {
  pendingAutoEnable: boolean
}

const INITIAL_ESTIMATED_TOTAL_BYTES = 13_800_000

const FALLBACK_ANDROID_STATUS: NativePyodideStatus = {
  version: PYODIDE_VERSION,
  installed: false,
  downloading: false,
  progress: 0,
  downloadedBytes: 0,
  totalBytes: INITIAL_ESTIMATED_TOTAL_BYTES,
  cachedBytes: 0,
  error: '',
}

const parseAndroidPyodideStatus = (raw: string | undefined): NativePyodideStatus => {
  if (!raw) {
    return FALLBACK_ANDROID_STATUS
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return FALLBACK_ANDROID_STATUS
    }
    const obj = parsed as Partial<NativePyodideStatus>
    return {
      version: typeof obj.version === 'string' && obj.version ? obj.version : PYODIDE_VERSION,
      installed: Boolean(obj.installed),
      downloading: Boolean(obj.downloading),
      progress: typeof obj.progress === 'number' && Number.isFinite(obj.progress) ? obj.progress : 0,
      downloadedBytes:
        typeof obj.downloadedBytes === 'number' && Number.isFinite(obj.downloadedBytes)
          ? obj.downloadedBytes
          : 0,
      totalBytes:
        typeof obj.totalBytes === 'number' && Number.isFinite(obj.totalBytes)
          ? obj.totalBytes
          : INITIAL_ESTIMATED_TOTAL_BYTES,
      cachedBytes:
        typeof obj.cachedBytes === 'number' && Number.isFinite(obj.cachedBytes)
          ? obj.cachedBytes
          : 0,
      error: typeof obj.error === 'string' ? obj.error : '',
    }
  } catch {
    return FALLBACK_ANDROID_STATUS
  }
}

const createInitialState = (): PyodideRuntimeState => {
  if (android) {
    const initial = parseAndroidPyodideStatus(android.getPyodideStatus?.())
    return {
      ...initial,
      pendingAutoEnable: false,
    }
  }
  return {
    version: PYODIDE_VERSION,
    installed: true,
    downloading: false,
    progress: 1,
    downloadedBytes: 0,
    totalBytes: INITIAL_ESTIMATED_TOTAL_BYTES,
    cachedBytes: 0,
    error: '',
    pendingAutoEnable: false,
  }
}

export const usePyodideRuntime = create<PyodideRuntimeState>(() => createInitialState())

const applyAndroidStatus = (status: NativePyodideStatus) => {
  const shouldEnable =
    status.installed && !status.downloading && usePyodideRuntime.getState().pendingAutoEnable
  usePyodideRuntime.setState((current) => ({
    ...status,
    pendingAutoEnable: shouldEnable ? false : status.error ? false : current.pendingAutoEnable,
  }))
  if (shouldEnable) {
    setPythonEnabled(true)
  }
}

if (typeof window !== 'undefined' && android) {
  window.addEventListener('android-pyodide-status', (event) => {
    const detail = (event as CustomEvent<NativePyodideStatus>).detail
    if (detail && typeof detail === 'object') {
      applyAndroidStatus(detail)
    }
  })
}

export const refreshPyodideStatus = () => {
  if (!android) {
    return
  }
  applyAndroidStatus(parseAndroidPyodideStatus(android.getPyodideStatus?.()))
}

export const togglePythonTool = (enabled: boolean) => {
  if (!enabled) {
    usePyodideRuntime.setState({ pendingAutoEnable: false })
    setPythonEnabled(false)
    return
  }
  if (!android) {
    setPythonEnabled(true)
    return
  }
  const latest = parseAndroidPyodideStatus(android.getPyodideStatus?.())
  if (latest.installed) {
    usePyodideRuntime.setState({ ...latest, pendingAutoEnable: false })
    setPythonEnabled(true)
    return
  }
  usePyodideRuntime.setState({ ...latest, error: '', pendingAutoEnable: true })
  android.beginPyodideDownload?.()
}

export const cancelPyodideDownload = () => {
  usePyodideRuntime.setState({ pendingAutoEnable: false })
  android?.cancelPyodideDownload?.()
}

export const clearPyodideCache = () => {
  usePyodideRuntime.setState({ pendingAutoEnable: false })
  setPythonEnabled(false)
  android?.clearPyodideCache?.()
}
