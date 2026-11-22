import type { NormalizedSearchResult, SearchToolsRuntimeConfig } from '../tools/types.js'
import { normalizeHttpBaseUrl } from './config.js'
import { DEFAULT_HTTP_TIMEOUT_MS, performHttpRequest, type HttpTransport } from './http.js'

const DEFAULT_COUNT = 6
const MIN_COUNT = 1
const MAX_COUNT = 10
const MAX_SNIPPET_CHARS = 400
const MAX_SEARCH_OUTPUT_CHARS = 6_000

const isHttpUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.trim()) {
    return false
  }
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null

const clampCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_COUNT
  }
  return Math.max(MIN_COUNT, Math.min(MAX_COUNT, Math.floor(value)))
}

const truncateSnippet = (raw: string | null | undefined): string => {
  const clean = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (clean.length <= MAX_SNIPPET_CHARS) {
    return clean
  }
  return `${clean.slice(0, MAX_SNIPPET_CHARS - 3)}...`
}

const parseJsonSafe = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const extractHttpError = (status: number, text: string, fallbackError?: string): string => {
  if (status === 0 && fallbackError) {
    return fallbackError
  }
  const parsed = parseJsonSafe(text) as Record<string, unknown> | null
  if (parsed && typeof parsed === 'object') {
    const nestedError =
      typeof parsed.error === 'object' && parsed.error !== null
        ? asString((parsed.error as Record<string, unknown>).message)
        : asString(parsed.error)
    const detail =
      typeof parsed.detail === 'object' && parsed.detail !== null
        ? asString((parsed.detail as Record<string, unknown>).error)
        : asString(parsed.detail)
    const msg = nestedError ?? detail ?? asString(parsed.msg) ?? asString(parsed.message)
    if (msg) {
      return status > 0 ? `HTTP ${status}: ${msg}` : msg
    }
  }
  return status > 0 ? `HTTP ${status}` : fallbackError || 'Request failed'
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

const normalizeResult = (item: {
  url: unknown
  title?: unknown
  snippet?: unknown
  siteName?: unknown
  siteIcon?: unknown
  publishedAt?: unknown
}): NormalizedSearchResult | null => {
  if (!isHttpUrl(item.url)) {
    return null
  }
  return {
    title: asString(item.title) ?? item.url,
    url: item.url,
    snippet: truncateSnippet(asString(item.snippet)),
    siteName: asString(item.siteName),
    siteIcon: isHttpUrl(item.siteIcon) ? item.siteIcon : null,
    publishedAt: asString(item.publishedAt),
  }
}

const searchDeepSeek = async (
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  if (!apiKey) {
    throw new Error('DeepSeek API Key is not configured')
  }
  const response = await transport(
    {
      url: 'https://api.deepseek.com/v1/tools/search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: query.slice(0, 128), count }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const data = record(parseJsonSafe(response.text))
  const items = Array.isArray(data.results) ? data.results : []
  return items
    .map((entry) => {
      const item = record(entry)
      return normalizeResult({
        url: item.url,
        title: item.title,
        snippet: asString(item.summary) ?? asString(item.snippet),
        siteName: item.site_name,
        siteIcon: item.site_icon,
        publishedAt: item.date,
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

const searchBocha = async (
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  if (!apiKey) {
    throw new Error('Bocha API Key is not configured')
  }
  const response = await transport(
    {
      url: 'https://api.bochaai.com/v1/web-search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, count, freshness: 'noLimit', summary: true }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const envelope = record(parseJsonSafe(response.text))
  if (envelope.code !== undefined && Number(envelope.code) !== 200) {
    throw new Error(asString(envelope.msg) ?? `Bocha API error code ${String(envelope.code)}`)
  }
  const data = record(envelope.data)
  const pages = record(data.webPages)
  const items = Array.isArray(pages.value) ? pages.value : []
  return items
    .map((entry) => {
      const item = record(entry)
      return normalizeResult({
        url: item.url,
        title: asString(item.name) ?? asString(item.title),
        snippet: asString(item.summary) ?? asString(item.snippet),
        siteName: item.siteName,
        siteIcon: item.siteIcon,
        publishedAt: asString(item.datePublished) ?? asString(item.dateLastCrawled),
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

const searchExa = async (
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  if (!apiKey) {
    throw new Error('Exa API Key is not configured')
  }
  const response = await transport(
    {
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: count,
        contents: { highlights: true },
      }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const data = record(parseJsonSafe(response.text))
  const items = Array.isArray(data.results) ? data.results : []
  return items
    .map((entry) => {
      const item = record(entry)
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
        : []
      const snippet =
        highlights.length > 0
          ? highlights.join(' ... ')
          : (asString(item.summary) ?? asString(item.text))
      return normalizeResult({
        url: item.url,
        title: item.title,
        snippet,
        siteIcon: item.favicon,
        publishedAt: item.publishedDate,
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

const searchTavily = async (
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  if (!apiKey) {
    throw new Error('Tavily API Key is not configured')
  }
  const response = await transport(
    {
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: count,
        include_published_date: true,
        include_favicon: true,
      }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const data = record(parseJsonSafe(response.text))
  const items = Array.isArray(data.results) ? data.results : []
  return items
    .map((entry) => {
      const item = record(entry)
      return normalizeResult({
        url: item.url,
        title: item.title,
        snippet: item.content,
        siteIcon: item.favicon,
        publishedAt: item.published_date,
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

const searchBrave = async (
  query: string,
  count: number,
  apiKey: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  if (!apiKey) {
    throw new Error('Brave API Key is not configured')
  }
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}&text_decorations=false`
  const response = await transport(
    {
      url,
      method: 'GET',
      headers: {
        'X-Subscription-Token': apiKey,
        Accept: 'application/json',
      },
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const data = record(parseJsonSafe(response.text))
  const web = record(data.web)
  const items = Array.isArray(web.results) ? web.results : []
  return items
    .map((entry) => {
      const item = record(entry)
      const profile = record(item.profile)
      const metaUrl = record(item.meta_url)
      const extraSnippets = Array.isArray(item.extra_snippets)
        ? item.extra_snippets.filter(
            (part): part is string => typeof part === 'string' && Boolean(part.trim())
          )
        : []
      const snippet = asString(item.description) ?? (extraSnippets.length > 0 ? extraSnippets.join(' ') : null)
      return normalizeResult({
        url: item.url,
        title: item.title,
        snippet,
        siteName: profile.name,
        siteIcon: profile.img ?? metaUrl.favicon,
        publishedAt: asString(item.page_age) ?? asString(item.age),
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

const searchSearxng = async (
  query: string,
  count: number,
  rawUrl: string,
  signal: AbortSignal | undefined,
  transport: HttpTransport
): Promise<NormalizedSearchResult[]> => {
  const baseUrl = normalizeHttpBaseUrl(rawUrl)
  if (!baseUrl) {
    throw new Error('SearXNG instance URL must be a valid http:// or https:// URL')
  }
  const url = `${baseUrl}/search?q=${encodeURIComponent(query)}&format=json`
  const response = await transport(
    {
      url,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    throw new Error(extractHttpError(response.status, response.text, response.error))
  }
  const parsed = parseJsonSafe(response.text)
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).results)) {
    throw new Error('SearXNG did not return a valid JSON search response')
  }
  const items = (parsed as { results: unknown[] }).results
  return items
    .map((entry) => {
      const item = record(entry)
      return normalizeResult({
        url: item.url,
        title: item.title,
        snippet: item.content,
        publishedAt: item.publishedDate,
      })
    })
    .filter((item): item is NormalizedSearchResult => item !== null)
    .slice(0, count)
}

export const formatSearchResultsForModel = (
  query: string,
  results: NormalizedSearchResult[],
  maxChars = MAX_SEARCH_OUTPUT_CHARS
): string => {
  if (results.length === 0) {
    return `No search results found for "${query}".`
  }
  const lines: string[] = []
  let total = 0
  for (let i = 0; i < results.length; i++) {
    const item = results[i]
    const meta = [item.siteName, item.publishedAt].filter(Boolean).join(' · ')
    const blockLines = [`[${i + 1}] ${item.title}`, `URL: ${item.url}`]
    if (meta) {
      blockLines.push(`Source: ${meta}`)
    }
    if (item.snippet) {
      blockLines.push(`Snippet: ${item.snippet}`)
    }
    const block = blockLines.join('\n')
    const sep = lines.length > 0 ? '\n\n' : ''
    if (total + sep.length + block.length > maxChars) {
      if (lines.length === 0) {
        return block.slice(0, maxChars)
      }
      break
    }
    lines.push(block)
    total += sep.length + block.length
  }
  return lines.join('\n\n')
}

export const executeWebSearch = async (
  rawQuery: string,
  rawCount: unknown,
  config: SearchToolsRuntimeConfig,
  signal?: AbortSignal,
  transport: HttpTransport = performHttpRequest
): Promise<{ results: NormalizedSearchResult[]; text: string }> => {
  const query = rawQuery.trim()
  if (!query) {
    throw new Error('Search query cannot be empty')
  }
  const count = clampCount(rawCount)
  let results: NormalizedSearchResult[]
  switch (config.engine) {
    case 'deepseek':
      results = await searchDeepSeek(query, count, config.officialApiKey.trim(), signal, transport)
      break
    case 'bocha':
      results = await searchBocha(query, count, config.apiKeys.bocha?.trim() ?? '', signal, transport)
      break
    case 'exa':
      results = await searchExa(query, count, config.apiKeys.exa?.trim() ?? '', signal, transport)
      break
    case 'tavily':
      results = await searchTavily(query, count, config.apiKeys.tavily?.trim() ?? '', signal, transport)
      break
    case 'brave':
      results = await searchBrave(query, count, config.apiKeys.brave?.trim() ?? '', signal, transport)
      break
    case 'searxng':
      results = await searchSearxng(query, count, config.searxngUrl, signal, transport)
      break
  }
  return { results, text: formatSearchResultsForModel(query, results) }
}

export const testSearchEngine = async (
  config: SearchToolsRuntimeConfig,
  signal?: AbortSignal,
  transport: HttpTransport = performHttpRequest
): Promise<void> => {
  await executeWebSearch('test', 1, config, signal, transport)
}
