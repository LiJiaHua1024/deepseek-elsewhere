import { android, type NativeHttpResponse } from '../../app/android.js'
import type { SearchToolsRuntimeConfig, ToolExecutionResult } from '../tools/types.js'
import {
  extractReadableFromHtml,
  isReadableContentType,
  MAX_FETCH_CHARS,
  truncateFetchedText,
} from './htmlExtract.js'
import { DEFAULT_HTTP_TIMEOUT_MS, performHttpRequest, type HttpTransport } from './http.js'

const MIN_DIRECT_HTML_CHARS = 80

const validateFetchUrl = (rawUrl: string): string | null => {
  const trimmed = rawUrl.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const url = new URL(trimmed)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null
    }
    return url.href
  } catch {
    return null
  }
}

const formatFetchedResult = (
  url: string,
  title: string | null,
  body: string
): ToolExecutionResult => {
  const cleanBody = body.trim()
  const hasHeading =
    title && (cleanBody.startsWith(`# ${title}`) || cleanBody.startsWith(title))
  const combined = title && !hasHeading && cleanBody ? `# ${title}\n\n${cleanBody}` : cleanBody || (title ?? '')
  const { text, truncated, charCount } = truncateFetchedText(combined, MAX_FETCH_CHARS)
  return {
    content: text || '(Page has no readable text content)',
    meta: {
      kind: 'fetch',
      url,
      title,
      truncated,
      charCount,
    },
  }
}

const isHtmlResponse = (contentType: string, text: string): boolean => {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') {
    return true
  }
  if (!mime) {
    const head = text.trimStart().slice(0, 64).toLowerCase()
    return head.startsWith('<!doctype html') || head.startsWith('<html')
  }
  return false
}

export const fetchViaDeepSeek = async (
  url: string,
  officialApiKey: string,
  signal?: AbortSignal,
  transport: HttpTransport = performHttpRequest
): Promise<ToolExecutionResult> => {
  const key = officialApiKey.trim()
  if (!key) {
    return { content: 'DeepSeek API Key is not configured.', isError: true }
  }
  const response = await transport(
    {
      url: 'https://api.deepseek.com/v1/tools/fetch',
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ url }),
      timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
    },
    signal
  )
  if (!response.ok) {
    return {
      content: response.error
        ? `Failed to fetch URL: ${response.error}`
        : `Failed to fetch URL: HTTP ${response.status}`,
      isError: true,
    }
  }
  try {
    const parsed = JSON.parse(response.text) as { title?: unknown; content?: unknown }
    const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : null
    const content = typeof parsed.content === 'string' ? parsed.content : ''
    if (!content.trim() && !title) {
      return { content: 'Page returned no readable content.', isError: true }
    }
    return formatFetchedResult(url, title, content)
  } catch {
    return { content: 'Invalid response from fetch service.', isError: true }
  }
}

const readDirectResponse = (
  url: string,
  response: NativeHttpResponse
):
  | { kind: 'binary'; result: ToolExecutionResult }
  | { kind: 'ok'; isHtml: boolean; title: string | null; text: string; result: ToolExecutionResult }
  | { kind: 'error'; result: ToolExecutionResult } => {
  if (!response.ok) {
    return {
      kind: 'error',
      result: {
        content: response.error
          ? `Failed to fetch URL: ${response.error}`
          : `Failed to fetch URL: HTTP ${response.status}`,
        isError: true,
      },
    }
  }
  if (!isReadableContentType(response.contentType)) {
    const typeLabel = response.contentType.split(';', 1)[0].trim() || 'binary'
    return {
      kind: 'binary',
      result: {
        content: `Cannot read non-text content (${typeLabel}).`,
        isError: true,
      },
    }
  }
  const html = isHtmlResponse(response.contentType, response.text)
  const extracted = html
    ? extractReadableFromHtml(response.text)
    : { title: null, text: response.text.trim() }
  return {
    kind: 'ok',
    isHtml: html,
    title: extracted.title,
    text: extracted.text,
    result: formatFetchedResult(url, extracted.title, extracted.text),
  }
}

export const fetchWebPage = async (
  rawUrl: string,
  config: SearchToolsRuntimeConfig,
  signal?: AbortSignal,
  options?: { isAndroid?: boolean; transport?: HttpTransport }
): Promise<ToolExecutionResult> => {
  if (config.webFetchMode === 'off') {
    return { content: 'Web page reading is turned off.', isError: true }
  }
  const url = validateFetchUrl(rawUrl)
  if (!url) {
    return {
      content: 'Invalid URL. Only http:// and https:// URLs without credentials are allowed.',
      isError: true,
    }
  }

  const transport = options?.transport ?? performHttpRequest
  const isAndroid = options?.isAndroid ?? Boolean(android?.beginHttpRequest)
  const hasOfficialKey = Boolean(config.officialApiKey.trim())

  const directFetch = () =>
    transport(
      {
        url,
        method: 'GET',
        headers: {
          Accept:
            'text/html,application/xhtml+xml,text/plain,application/json,application/xml;q=0.9,*/*;q=0.1',
        },
        timeoutMs: DEFAULT_HTTP_TIMEOUT_MS,
      },
      signal
    )

  if (isAndroid) {
    const raw = await directFetch()
    const direct = readDirectResponse(url, raw)
    if (direct.kind === 'binary') {
      return direct.result
    }
    if (direct.kind === 'ok') {
      if (!direct.isHtml || direct.text.length >= MIN_DIRECT_HTML_CHARS || !hasOfficialKey) {
        return direct.result
      }
      const fallback = await fetchViaDeepSeek(url, config.officialApiKey, signal, transport)
      return fallback.isError ? direct.result : fallback
    }
    if (hasOfficialKey) {
      const fallback = await fetchViaDeepSeek(url, config.officialApiKey, signal, transport)
      if (!fallback.isError) {
        return fallback
      }
    }
    return direct.result
  }

  if (hasOfficialKey) {
    const viaDeepSeek = await fetchViaDeepSeek(url, config.officialApiKey, signal, transport)
    if (!viaDeepSeek.isError) {
      return viaDeepSeek
    }
  }

  const raw = await directFetch()
  const direct = readDirectResponse(url, raw)
  if (direct.kind === 'ok' || direct.kind === 'binary') {
    return direct.result
  }
  return {
    content: raw.error
      ? `Failed to fetch URL (possibly blocked by CORS or network error): ${raw.error}`
      : direct.result.content,
    isError: true,
  }
}
