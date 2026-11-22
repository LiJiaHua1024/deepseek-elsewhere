export const MAX_FETCH_CHARS = 12_000

const READABLE_EXACT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/xhtml+xml',
  'application/rss+xml',
  'application/atom+xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
])

export const isReadableContentType = (contentType: string): boolean => {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  if (!mime) {
    return true
  }
  if (mime.startsWith('text/')) {
    return true
  }
  if (READABLE_EXACT_MIMES.has(mime)) {
    return true
  }
  return mime.endsWith('+json') || mime.endsWith('+xml')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
}

export const decodeHtmlEntities = (input: string): string =>
  input.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match
    }
    return Object.hasOwn(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match
  })

const stripTags = (html: string): string => html.replace(/<[^>]+>/g, '')

const stripTagBlocks = (html: string, tags: readonly string[]): string => {
  let result = html
  for (const tag of tags) {
    const paired = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi')
    const selfClosing = new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi')
    result = result.replace(paired, '\n').replace(selfClosing, '\n')
  }
  return result
}

const htmlFragmentToText = (fragment: string): string => {
  let cleaned = stripTagBlocks(fragment, ['nav', 'footer', 'aside', 'form'])

  const codeBlocks: string[] = []
  cleaned = cleaned.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, inner: string) => {
    const code = decodeHtmlEntities(
      stripTags(inner.replace(/<br\s*\/?>/gi, '\n'))
    )
      .replace(/\r\n?/g, '\n')
      .trim()
    const token = `\n\n@@CODE_BLOCK_${codeBlocks.length}@@\n\n`
    codeBlocks.push(code ? `\`\`\`\n${code}\n\`\`\`` : '')
    return token
  })

  cleaned = cleaned.replace(
    /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_match, level: string, inner: string) => {
      const heading = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, ' ').trim()
      return heading ? `\n\n${'#'.repeat(Number(level))} ${heading}\n\n` : '\n'
    }
  )

  cleaned = cleaned.replace(
    /<a\b[^>]*href=(["'])(https?:\/\/[^"']+)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, _quote: string, href: string, inner: string) => {
      const label = decodeHtmlEntities(stripTags(inner)).replace(/\s+/g, ' ').trim()
      return label ? `[${label}](${href})` : href
    }
  )

  cleaned = cleaned
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(?:t[dh])\b[^>]*>/gi, ' ')
    .replace(/<\/(?:t[dh])>/gi, ' | ')
    .replace(/<\/?(?:p|div|section|article|main|header|blockquote|tr|ul|ol|table|dl|dt|dd|hr)\b[^>]*>/gi, '\n')

  cleaned = stripTags(cleaned)
  cleaned = decodeHtmlEntities(cleaned)

  cleaned = cleaned.replace(/\r\n?/g, '\n')
  cleaned = cleaned
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  for (let i = 0; i < codeBlocks.length; i++) {
    cleaned = cleaned.replace(`@@CODE_BLOCK_${i}@@`, codeBlocks[i])
  }

  return cleaned.replace(/\n{3,}/g, '\n\n').trim()
}

const extractTagContents = (html: string, tag: string): string[] => {
  const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi')
  const matches: string[] = []
  let match: RegExpExecArray | null
  while ((match = regex.exec(html)) !== null) {
    matches.push(match[1])
  }
  return matches
}

export const extractReadableFromHtml = (html: string): { title: string | null; text: string } => {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const rawTitle = titleMatch
    ? decodeHtmlEntities(stripTags(titleMatch[1])).replace(/\s+/g, ' ').trim()
    : ''
  const title = rawTitle || null

  let stripped = html.replace(/<!--[\s\S]*?-->/g, '')
  stripped = stripTagBlocks(stripped, ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head'])

  const mainCandidates = extractTagContents(stripped, 'main')
  for (const candidate of mainCandidates) {
    const text = htmlFragmentToText(candidate)
    if (text.length >= 80) {
      return { title, text }
    }
  }

  const articleCandidates = extractTagContents(stripped, 'article')
  if (articleCandidates.length > 0) {
    const combinedArticles = htmlFragmentToText(articleCandidates.join('\n\n'))
    if (combinedArticles.length >= 80) {
      return { title, text: combinedArticles }
    }
  }

  const bodyMatch = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(stripped)
  const fallbackSource = bodyMatch ? bodyMatch[1] : stripped
  return { title, text: htmlFragmentToText(fallbackSource) }
}

export const truncateFetchedText = (
  text: string,
  maxChars = MAX_FETCH_CHARS
): { text: string; truncated: boolean; charCount: number } => {
  const charCount = text.length
  if (charCount <= maxChars) {
    return { text, truncated: false, charCount }
  }
  return {
    text: `${text.slice(0, maxChars)}\n\n[Truncated: showing first ${maxChars} of ${charCount} chars]`,
    truncated: true,
    charCount,
  }
}
