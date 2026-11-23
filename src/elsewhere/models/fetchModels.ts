import { android } from '../../app/android.js'
import type { ChatApiFormat } from '../../services/api/chatConfig.js'
import { performHttpRequest, type HttpTransport } from '../search/http.js'
import { inferModelGroup } from './presets.js'
import type { ModelProviderConfig, ProviderModelItem } from './types.js'

export const FETCH_MODELS_TIMEOUT_MS = 15_000

const OFFICIAL_API_ORIGIN = typeof __API_ORIGIN__ === 'string' ? __API_ORIGIN__ : 'https://api.deepseek.com'

export type ParsedRemoteModel = {
  id: string
  label: string
  group: string
  contextWindow?: number
}

export type FetchModelsResult =
  | { ok: true; models: ParsedRemoteModel[] }
  | { ok: false; error: string; status?: number; empty?: boolean }

export type TestConnectionResult =
  | { ok: true; modelCount?: number }
  | { ok: false; error: string; status?: number }

const STRIP_SUFFIXES = ['/chat/completions', '/responses', '/messages', '/models'] as const

export const normalizeProviderBaseUrl = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      trimmed.includes('#')
    ) {
      return null
    }
    let path = url.pathname.replace(/\/+$/, '')
    for (const suffix of STRIP_SUFFIXES) {
      if (path.endsWith(suffix)) {
        path = path.slice(0, -suffix.length).replace(/\/+$/, '')
        break
      }
    }
    url.pathname = path || '/'
    url.search = ''
    url.hash = ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return null
  }
}

export const buildModelsUrl = (baseUrl: string, format: ChatApiFormat): string | null => {
  const normalized = normalizeProviderBaseUrl(baseUrl)
  if (!normalized) {
    return null
  }
  const url = new URL(normalized)
  const path = url.pathname.replace(/\/+$/, '')
  const version = format === 'messages' && !path.endsWith('/v1') ? '/v1' : ''
  url.pathname = `${path}${version}/models`
  return url.href
}

export const buildProviderModelsHeaders = (
  modelsUrl: string,
  format: ChatApiFormat,
  apiKey: string
): Record<string, string> => {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  }
  const key = apiKey.trim()
  let hostname = ''
  try {
    hostname = new URL(modelsUrl).hostname
  } catch {
    hostname = ''
  }
  if (format === 'messages' && hostname === 'api.anthropic.com') {
    headers['anthropic-version'] = '2023-06-01'
    if (key) {
      headers['x-api-key'] = key
    }
    if (!android) {
      headers['anthropic-dangerous-direct-browser-access'] = 'true'
    }
    return headers
  }
  if (key) {
    headers.Authorization = `Bearer ${key}`
  }
  return headers
}

const asNonEmptyString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const asContextWindow = (record: Record<string, unknown>): number | undefined => {
  const candidates = [
    record.context_length,
    record.context_window,
    record.inputTokenLimit,
    record.max_context_length,
  ]
  for (const candidate of candidates) {
    if (
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 1024
    ) {
      return candidate
    }
  }
  return undefined
}

export const parseModelsResponse = (payload: unknown): ParsedRemoteModel[] => {
  let rawList: unknown[] = []
  if (Array.isArray(payload)) {
    rawList = payload
  } else if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.data)) {
      rawList = obj.data
    } else if (Array.isArray(obj.models)) {
      rawList = obj.models
    }
  }

  const seen = new Set<string>()
  const parsed: ParsedRemoteModel[] = []
  for (const entry of rawList) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (id && !seen.has(id)) {
        seen.add(id)
        parsed.push({ id, label: id, group: inferModelGroup(id) })
      }
      continue
    }
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const record = entry as Record<string, unknown>
    const rawId = asNonEmptyString(record.id) ?? asNonEmptyString(record.name)
    if (!rawId || seen.has(rawId)) {
      continue
    }
    seen.add(rawId)
    const label =
      asNonEmptyString(record.display_name) ??
      asNonEmptyString(record.displayName) ??
      asNonEmptyString(record.name) ??
      rawId
    const contextWindow = asContextWindow(record)
    parsed.push({
      id: rawId,
      label,
      group: inferModelGroup(rawId),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    })
  }
  return parsed
}

export const mergeFetchedModels = (
  existing: readonly ProviderModelItem[],
  fetched: readonly ParsedRemoteModel[]
): ProviderModelItem[] => {
  const fetchedMap = new Map(fetched.map((item) => [item.id, item]))
  const existingIds = new Set<string>()
  const merged: ProviderModelItem[] = existing.map((item) => {
    existingIds.add(item.id)
    const remote = fetchedMap.get(item.id)
    if (!remote) {
      return item
    }
    return {
      ...item,
      label: item.label && item.label !== item.id ? item.label : remote.label,
      group: item.group || remote.group,
      ...(item.contextWindow !== undefined
        ? { contextWindow: item.contextWindow }
        : remote.contextWindow !== undefined
          ? { contextWindow: remote.contextWindow }
          : {}),
    }
  })

  for (const remote of fetched) {
    if (existingIds.has(remote.id)) {
      continue
    }
    merged.push({
      id: remote.id,
      label: remote.label,
      group: remote.group,
      enabled: false,
      ...(remote.contextWindow !== undefined ? { contextWindow: remote.contextWindow } : {}),
    })
  }
  return merged
}

const extractHttpErrorMessage = (text: string, status: number, fallback?: string): string => {
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>
        if (obj.error && typeof obj.error === 'object') {
          const msg = asNonEmptyString((obj.error as Record<string, unknown>).message)
          if (msg) {
            return msg
          }
        }
        const topMsg = asNonEmptyString(obj.message)
        if (topMsg) {
          return topMsg
        }
      }
    } catch {
      // 非 JSON 错误文本直接截取展示
    }
    const clean = text.trim()
    return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean
  }
  if (fallback?.trim()) {
    return fallback.trim()
  }
  return status > 0 ? `HTTP ${status}` : '网络请求失败'
}

export const fetchProviderModels = async (
  provider: Pick<ModelProviderConfig, 'baseUrl' | 'format' | 'apiKey'>,
  options?: {
    signal?: AbortSignal
    transport?: HttpTransport
    timeoutMs?: number
  }
): Promise<FetchModelsResult> => {
  const url = buildModelsUrl(provider.baseUrl, provider.format)
  if (!url) {
    return { ok: false, error: '接口地址格式无效' }
  }
  const transport = options?.transport ?? performHttpRequest
  const response = await transport(
    {
      url,
      method: 'GET',
      headers: buildProviderModelsHeaders(url, provider.format, provider.apiKey),
      timeoutMs: options?.timeoutMs ?? FETCH_MODELS_TIMEOUT_MS,
    },
    options?.signal
  )
  if (!response.ok) {
    return {
      ok: false,
      status: response.status || undefined,
      error: extractHttpErrorMessage(response.text, response.status, response.error),
    }
  }
  let payload: unknown
  try {
    payload = JSON.parse(response.text)
  } catch {
    return {
      ok: false,
      status: response.status || undefined,
      error: '接口未返回有效的 JSON 模型列表',
    }
  }
  const models = parseModelsResponse(payload)
  if (models.length === 0) {
    return {
      ok: false,
      empty: true,
      error: '接口未返回模型列表，可手动添加模型 ID',
    }
  }
  return { ok: true, models }
}

export const testProviderConnection = async (
  provider: Pick<ModelProviderConfig, 'builtin' | 'baseUrl' | 'format' | 'apiKey'>,
  options?: {
    officialApiKey?: string | null
    signal?: AbortSignal
    transport?: HttpTransport
    timeoutMs?: number
  }
): Promise<TestConnectionResult> => {
  const transport = options?.transport ?? performHttpRequest
  if (provider.builtin) {
    const key = (options?.officialApiKey ?? '').trim()
    if (!key) {
      return { ok: false, error: '请先配置 DeepSeek API Key' }
    }
    const response = await transport(
      {
        url: `${OFFICIAL_API_ORIGIN}/models`,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
        },
        timeoutMs: options?.timeoutMs ?? FETCH_MODELS_TIMEOUT_MS,
      },
      options?.signal
    )
    if (!response.ok) {
      return {
        ok: false,
        status: response.status || undefined,
        error: extractHttpErrorMessage(response.text, response.status, response.error),
      }
    }
    try {
      const models = parseModelsResponse(JSON.parse(response.text))
      return { ok: true, modelCount: models.length }
    } catch {
      return { ok: true }
    }
  }

  const fetched = await fetchProviderModels(provider, options)
  if (fetched.ok) {
    return { ok: true, modelCount: fetched.models.length }
  }
  if (fetched.empty) {
    return { ok: true, modelCount: 0 }
  }
  return { ok: false, error: fetched.error, status: fetched.status }
}
