export class SpeechTextEmptyError extends Error {
  constructor() {
    super('No speakable text after cleaning')
    this.name = 'SpeechTextEmptyError'
  }
}

const FENCED_CODE_BLOCK = /```[\s\S]*?```|~~~[\s\S]*?~~~/g
const DISPLAY_MATH_DOLLAR = /\$\$[\s\S]*?\$\$/g
const DISPLAY_MATH_BRACKET = /\\\[[\s\S]*?\\\]/g
const TABLE_SEPARATOR_LINE =
  /^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/gm
const INLINE_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g
const MARKDOWN_LINK = /\[([^\]]+)\]\([^)]*\)/g
const CITATION_REF = /\[(?:\d+|citation:\s*\d+)\]/gi
const BARE_URL = /https?:\/\/[^\s)>"']+/gi
const INLINE_CODE = /`([^`]*)`/g

export const cleanTextForSpeech = (markdown: string): string => {
  if (!markdown) {
    return ''
  }
  let text = markdown.replace(/\r\n?/g, '\n')
  text = text.replace(FENCED_CODE_BLOCK, '\n')
  text = text.replace(DISPLAY_MATH_DOLLAR, '\n')
  text = text.replace(DISPLAY_MATH_BRACKET, '\n')
  text = text.replace(TABLE_SEPARATOR_LINE, '\n')
  text = text.replace(INLINE_IMAGE, '$1')
  text = text.replace(MARKDOWN_LINK, '$1')
  text = text.replace(CITATION_REF, '')
  text = text.replace(BARE_URL, '')
  text = text.replace(INLINE_CODE, '$1')

  const lines = text.split('\n').map((line) => {
    let cleaned = line.trim()
    if (!cleaned) {
      return ''
    }
    // Strip headings, blockquotes, list markers, and horizontal rules
    if (/^([-*_])\1{2,}$/.test(cleaned)) {
      return ''
    }
    cleaned = cleaned.replace(/^#{1,6}\s+/, '')
    cleaned = cleaned.replace(/^(?:>\s*)+/, '')
    cleaned = cleaned.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    // Strip Markdown table pipes if a table row remains
    if (cleaned.startsWith('|') && cleaned.endsWith('|')) {
      cleaned = cleaned
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean)
        .join('，')
    }
    // Strip emphasis / strikethrough markers while keeping content
    cleaned = cleaned
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)(.*?)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/[*_`~]/g, '')
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim()
    return cleaned
  })

  return lines
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const DEFAULT_FIRST_MAX = 120
const DEFAULT_TARGET_MIN = 120
const DEFAULT_TARGET_MAX = 260
const DEFAULT_HARD_MAX = 400

const splitLongSentence = (sentence: string, maxLen: number): string[] => {
  if (sentence.length <= maxLen) {
    return [sentence]
  }
  const parts: string[] = []
  let remaining = sentence
  while (remaining.length > maxLen) {
    const windowSlice = remaining.slice(0, maxLen)
    let cut = -1
    for (const sep of ['，', ',', '、', '：', ':', ' ']) {
      const idx = windowSlice.lastIndexOf(sep)
      if (idx >= Math.floor(maxLen * 0.45)) {
        cut = Math.max(cut, idx + 1)
      }
    }
    if (cut <= 0) {
      cut = maxLen
    }
    const head = remaining.slice(0, cut).trim()
    if (head) {
      parts.push(head)
    }
    remaining = remaining.slice(cut).trim()
  }
  if (remaining) {
    parts.push(remaining)
  }
  return parts
}

export const splitSpeechSegments = (
  cleanedText: string,
  options?: {
    firstMax?: number
    targetMin?: number
    targetMax?: number
    hardMax?: number
  }
): string[] => {
  const normalized = cleanedText.trim()
  if (!normalized) {
    return []
  }
  const firstMax = options?.firstMax ?? DEFAULT_FIRST_MAX
  const targetMin = options?.targetMin ?? DEFAULT_TARGET_MIN
  const targetMax = options?.targetMax ?? DEFAULT_TARGET_MAX
  const hardMax = options?.hardMax ?? DEFAULT_HARD_MAX

  const rawSentences = normalized
    .split(/(?<=[。！？!?；;\n])/)
    .map((item) => item.trim())
    .filter(Boolean)

  const units: string[] = []
  for (const sentence of rawSentences) {
    const limit = units.length === 0 ? firstMax : hardMax
    units.push(...splitLongSentence(sentence, limit))
  }

  const segments: string[] = []
  let buffer = ''

  for (const unit of units) {
    const isFirst = segments.length === 0
    const softMax = isFirst ? firstMax : targetMax
    const hardLimit = isFirst ? firstMax : hardMax
    if (!buffer) {
      buffer = unit
      if (isFirst && buffer.length >= Math.min(firstMax, 60)) {
        segments.push(buffer)
        buffer = ''
      }
      continue
    }
    const candidate = `${buffer} ${unit}`.trim()
    if (
      candidate.length <= softMax ||
      (buffer.length < targetMin && candidate.length <= hardLimit)
    ) {
      buffer = candidate
    } else {
      segments.push(buffer)
      buffer = unit
    }
  }
  if (buffer) {
    segments.push(buffer)
  }
  return segments
}
