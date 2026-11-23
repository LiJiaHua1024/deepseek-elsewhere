import { create } from 'zustand'

export const PYODIDE_VERSION = '0.27.6'
export const PYODIDE_CDN_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`
export const PYTHON_TIMEOUT_MS = 30_000
export const PYTHON_MAX_OUTPUT_CHARS = 12_000
export const PYTHON_MAX_IMAGES = 3
export const PYTHON_MAX_FILE_BYTES = 5 * 1024 * 1024

const STORAGE_KEY = 'elsewhere:builtin-tools-config'

export type BuiltinToolsConfig = {
  pythonEnabled: boolean
  historySearchEnabled: boolean
}

const DEFAULT_CONFIG: BuiltinToolsConfig = {
  pythonEnabled: false,
  historySearchEnabled: false,
}

const readStoredConfig = (): BuiltinToolsConfig => {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_CONFIG
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_CONFIG
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_CONFIG
    }
    const record = parsed as Record<string, unknown>
    return {
      pythonEnabled: record.pythonEnabled === true,
      historySearchEnabled: record.historySearchEnabled === true,
    }
  } catch {
    return DEFAULT_CONFIG
  }
}

const persistConfig = (config: BuiltinToolsConfig) => {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // Ignore storage quota or security restrictions
  }
}

export const useBuiltinToolsConfig = create<BuiltinToolsConfig>(() => readStoredConfig())

const updateConfig = (updater: (current: BuiltinToolsConfig) => BuiltinToolsConfig) => {
  const next = updater(useBuiltinToolsConfig.getState())
  persistConfig(next)
  useBuiltinToolsConfig.setState(next)
}

export const setPythonEnabled = (pythonEnabled: boolean) => {
  updateConfig((current) => ({ ...current, pythonEnabled }))
}

export const setHistorySearchEnabled = (historySearchEnabled: boolean) => {
  updateConfig((current) => ({ ...current, historySearchEnabled }))
}
