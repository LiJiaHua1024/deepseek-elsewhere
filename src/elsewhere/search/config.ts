import { create } from 'zustand'
import type {
  SearchEngineId,
  SearchEngineKeyId,
  SearchToolsRuntimeConfig,
  WebFetchMode,
} from '../tools/types.js'

const STORAGE_KEY = 'elsewhere:search-tools-config'

export type SearchToolsConfigState = {
  engine: SearchEngineId
  apiKeys: Partial<Record<SearchEngineKeyId, string>>
  searxngUrl: string
  webFetchMode: WebFetchMode
  useExternalOnOfficial: boolean
}

export const SEARCH_ENGINE_OPTIONS: readonly { id: SearchEngineId; label: string; enLabel?: string }[] =
  [
    { id: 'deepseek', label: 'DeepSeek Search' },
    { id: 'bocha', label: '博查', enLabel: 'Bocha' },
    { id: 'exa', label: 'Exa' },
    { id: 'tavily', label: 'Tavily' },
    { id: 'brave', label: 'Brave' },
    { id: 'searxng', label: 'SearXNG' },
  ]

export const getSearchEngineLabel = (id: SearchEngineId, zh = true): string => {
  const item = SEARCH_ENGINE_OPTIONS.find((option) => option.id === id)
  if (!item) {
    return id
  }
  return !zh && item.enLabel ? item.enLabel : item.label
}

export const normalizeHttpBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null
    }
    const cleanPath = url.pathname.replace(/\/+$/, '')
    return `${url.origin}${cleanPath}`
  } catch {
    return null
  }
}

const isEngineId = (value: unknown): value is SearchEngineId =>
  value === 'deepseek' ||
  value === 'bocha' ||
  value === 'exa' ||
  value === 'tavily' ||
  value === 'brave' ||
  value === 'searxng'

const DEFAULT_STATE: SearchToolsConfigState = {
  engine: 'deepseek',
  apiKeys: {},
  searxngUrl: '',
  webFetchMode: 'auto',
  useExternalOnOfficial: false,
}

const readStored = (): SearchToolsConfigState => {
  if (typeof localStorage === 'undefined') {
    return DEFAULT_STATE
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_STATE
    }
    const parsed = JSON.parse(raw) as Partial<SearchToolsConfigState> | null
    if (!parsed || typeof parsed !== 'object') {
      return DEFAULT_STATE
    }
    const apiKeys: Partial<Record<SearchEngineKeyId, string>> = {}
    if (parsed.apiKeys && typeof parsed.apiKeys === 'object') {
      for (const key of ['bocha', 'exa', 'tavily', 'brave'] as const) {
        const val = parsed.apiKeys[key]
        if (typeof val === 'string' && val.trim()) {
          apiKeys[key] = val.trim()
        }
      }
    }
    return {
      engine: isEngineId(parsed.engine) ? parsed.engine : 'deepseek',
      apiKeys,
      searxngUrl: typeof parsed.searxngUrl === 'string' ? parsed.searxngUrl : '',
      webFetchMode: parsed.webFetchMode === 'off' ? 'off' : 'auto',
      useExternalOnOfficial: parsed.useExternalOnOfficial === true,
    }
  } catch {
    return DEFAULT_STATE
  }
}

const persistState = (state: SearchToolsConfigState) => {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 隐私模式或存储受限时仍更新内存态
  }
}

export const useSearchToolsConfig = create<SearchToolsConfigState>(() => readStored())

const updateConfig = (updater: (current: SearchToolsConfigState) => SearchToolsConfigState) => {
  const next = updater(useSearchToolsConfig.getState())
  persistState(next)
  useSearchToolsConfig.setState(next)
}

export const setSearchEngine = (engine: SearchEngineId) =>
  updateConfig((current) => ({ ...current, engine }))

export const setSearchEngineApiKey = (engine: SearchEngineKeyId, key: string) =>
  updateConfig((current) => {
    const trimmed = key.trim()
    const nextKeys: Partial<Record<SearchEngineKeyId, string>> = Object.fromEntries(
      Object.entries(current.apiKeys).filter(([id]) => id !== engine)
    )
    if (trimmed) {
      nextKeys[engine] = trimmed
    }
    return { ...current, apiKeys: nextKeys }
  })

export const setSearxngUrl = (searxngUrl: string) =>
  updateConfig((current) => ({ ...current, searxngUrl }))

export const setWebFetchMode = (webFetchMode: WebFetchMode) =>
  updateConfig((current) => ({ ...current, webFetchMode }))

export const setUseExternalOnOfficial = (useExternalOnOfficial: boolean) =>
  updateConfig((current) => ({ ...current, useExternalOnOfficial }))

export const isSearchEngineReady = (
  state: Pick<SearchToolsRuntimeConfig, 'engine' | 'apiKeys' | 'searxngUrl'>,
  officialApiKey: string | null | undefined
): boolean => {
  if (state.engine === 'deepseek') {
    return Boolean(officialApiKey?.trim())
  }
  if (state.engine === 'searxng') {
    return normalizeHttpBaseUrl(state.searxngUrl) !== null
  }
  return Boolean(state.apiKeys[state.engine]?.trim())
}

export const getSearchToolsRuntimeConfig = (
  officialApiKey: string | null | undefined
): SearchToolsRuntimeConfig => {
  const state = useSearchToolsConfig.getState()
  return {
    engine: state.engine,
    officialApiKey: officialApiKey?.trim() ?? '',
    apiKeys: { ...state.apiKeys },
    searxngUrl: state.searxngUrl,
    webFetchMode: state.webFetchMode,
    useExternalOnOfficial: state.useExternalOnOfficial,
  }
}
