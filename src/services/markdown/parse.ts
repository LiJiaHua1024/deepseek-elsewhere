import type { Node as MdAstNode, Nodes, Parent, RootContent, Root, Text } from 'mdast'
import { findAndReplace } from 'mdast-util-find-and-replace'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-llm-math'
import type { Source } from '../chat/view.js'

/** 正文里的 [citation:N]，已换成对应来源 */
export interface CitationNode extends MdAstNode {
  type: 'citation'
  source: Source
}

declare module 'mdast' {
  interface RootContentMap {
    citation: CitationNode
  }

  interface PhrasingContentMap {
    citation: CitationNode
  }
}

const text = (value: string): Text => ({ type: 'text', value })

export type MarkdownParseOptions = { sources: Source[] | undefined; disableLink: boolean }

const parserOptions = {
  extensions: [
    // codeIndented 语法导致有前导空格的列表无法正常渲染
    { ...gfm(), disable: { null: ['codeIndented'] } },
    math({ singleDollarTextMath: true }),
  ],
  mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
}

const MAX_MATH_REPAIR_PASSES = 64

type TextEdit = { start: number; end: number; replacement: string }

const isEscaped = (text: string, index: number): boolean => {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) {
    backslashes++
  }
  return backslashes % 2 === 1
}

const findLineStart = (text: string, offset: number): number => {
  for (let i = offset - 1; i >= 0; i--) {
    if (text[i] === '\n' || text[i] === '\r') {
      return i + 1
    }
  }
  return 0
}

const detectNewline = (text: string, nearOffset: number): string => {
  const nl = text.indexOf('\n', nearOffset)
  if (nl > 0 && text[nl - 1] === '\r') {
    return '\r\n'
  }
  const prevNl = text.lastIndexOf('\n', nearOffset)
  if (prevNl > 0 && text[prevNl - 1] === '\r') {
    return '\r\n'
  }
  return '\n'
}

const getVisualWidth = (text: string): number => {
  let width = 0
  for (let i = 0; i < text.length; i++) {
    width += text[i] === '\t' ? 4 - (width % 4) : 1
  }
  return width
}

/** 将容器起始行前缀（如 `> 1. `、`  - `、`   `）转为后续行的续行前缀 */
const toContinuationPrefix = (rawPrefix: string): string => {
  let out = ''
  let i = 0
  while (i < rawPrefix.length) {
    const ch = rawPrefix[i]
    if (ch === ' ' || ch === '\t') {
      out += ch
      i++
      continue
    }
    if (ch === '>') {
      out += '>'
      i++
      if (rawPrefix[i] === ' ') {
        out += ' '
        i++
      }
      continue
    }
    if (ch === '-' || ch === '*' || ch === '+') {
      out += ' '
      i++
      while (i < rawPrefix.length && (rawPrefix[i] === ' ' || rawPrefix[i] === '\t')) {
        out += rawPrefix[i]
        i++
      }
      continue
    }
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < rawPrefix.length && rawPrefix[j] >= '0' && rawPrefix[j] <= '9') {
        j++
      }
      if (rawPrefix[j] === '.' || rawPrefix[j] === ')') {
        j++
        out += ' '.repeat(j - i)
        i = j
        while (i < rawPrefix.length && (rawPrefix[i] === ' ' || rawPrefix[i] === '\t')) {
          out += rawPrefix[i]
          i++
        }
        continue
      }
    }
    out += ' '
    i++
  }
  return out
}

const countBlockquoteMarkers = (line: string): { count: number; afterOffset: number } => {
  let count = 0
  let i = 0
  while (i < line.length) {
    let j = i
    while (j < line.length && (line[j] === ' ' || line[j] === '\t')) {
      j++
    }
    if (line[j] === '>') {
      count++
      i = j + 1
    } else {
      break
    }
  }
  return { count, afterOffset: i }
}

const indentLineToPrefix = (line: string, contPrefix: string, blankLinePrefix: string): string => {
  if (!/[^\t ]/.test(line)) {
    return blankLinePrefix
  }
  const lastGt = contPrefix.lastIndexOf('>')
  if (lastGt >= 0) {
    const required = countBlockquoteMarkers(contPrefix)
    const existing = countBlockquoteMarkers(line)
    if (existing.count < required.count) {
      return contPrefix + line
    }
    const tailPrefix = contPrefix.slice(lastGt + 1)
    const afterGt = line.slice(existing.afterOffset)
    const leading = /^[ \t]*/.exec(afterGt)?.[0] ?? ''
    if (getVisualWidth(leading) >= getVisualWidth(tailPrefix)) {
      return line
    }
    return line.slice(0, existing.afterOffset) + tailPrefix + afterGt.slice(leading.length)
  }
  const leading = /^[ \t]*/.exec(line)?.[0] ?? ''
  if (getVisualWidth(leading) >= getVisualWidth(contPrefix)) {
    return line
  }
  return contPrefix + line.slice(leading.length)
}

const indentBlockLines = (
  slice: string,
  contPrefix: string,
  blankLinePrefix: string
): string => {
  let result = ''
  let pos = 0
  while (pos <= slice.length) {
    const cr = slice.indexOf('\r', pos)
    const lf = slice.indexOf('\n', pos)
    let lineEnd = slice.length
    let eol = ''
    if (lf >= 0 && (cr < 0 || lf < cr)) {
      lineEnd = lf
      eol = '\n'
    } else if (cr >= 0) {
      lineEnd = cr
      eol = slice[cr + 1] === '\n' ? '\r\n' : '\r'
    }
    const line = slice.slice(pos, lineEnd)
    result += indentLineToPrefix(line, contPrefix, blankLinePrefix) + eol
    if (!eol) {
      break
    }
    pos = lineEnd + eol.length
  }
  return result
}

const findUnescapedClosingBracket = (
  text: string,
  fromIndex: number,
  skipInlineCode: boolean
): { index: number; trailingText: boolean; lineEndOffset: number } | null => {
  let backtickRun = 0
  for (let i = fromIndex; i < text.length; i++) {
    if (skipInlineCode && text[i] === '`') {
      let run = 1
      while (text[i + run] === '`') {
        run++
      }
      if (backtickRun === 0) {
        backtickRun = run
      } else if (backtickRun === run) {
        backtickRun = 0
      }
      i += run - 1
      continue
    }
    if (backtickRun > 0) {
      continue
    }
    if (text[i] === '\\' && text[i + 1] === ']' && !isEscaped(text, i)) {
      let restEnd = i + 2
      let hasNonSpace = false
      while (restEnd < text.length && text[restEnd] !== '\r' && text[restEnd] !== '\n') {
        if (text[restEnd] !== ' ' && text[restEnd] !== '\t') {
          hasNonSpace = true
        }
        restEnd++
      }
      return { index: i, trailingText: hasNonSpace, lineEndOffset: restEnd }
    }
  }
  return null
}

const getDeepestTrailingChild = (node: RootContent): Nodes | undefined => {
  let tail: Nodes | undefined = node
  while (tail && (tail.type === 'list' || tail.type === 'blockquote')) {
    if (tail.type === 'list') {
      const lastItem: Nodes | undefined = tail.children[tail.children.length - 1]
      tail = lastItem?.type === 'listItem' ? lastItem.children[lastItem.children.length - 1] : undefined
    } else {
      tail = tail.children[tail.children.length - 1]
    }
  }
  return tail
}

const isMathClosed = (mathSource: string): { closed: boolean; dollarLen: number } => {
  if (mathSource.startsWith('\\[')) {
    const trimmed = mathSource.replace(/[ \t]+$/, '')
    const closed =
      trimmed.length >= 4 &&
      trimmed.endsWith('\\]') &&
      !isEscaped(trimmed, trimmed.length - 2)
    return { closed, dollarLen: 0 }
  }
  const dollars = /^(\$+)/.exec(mathSource)
  const dollarLen = dollars ? dollars[1].length : 0
  if (dollarLen >= 2) {
    const closePattern = new RegExp(`(?:\\r\\n?|\\n)[ \\t]*\\${'$'}{${dollarLen},}[ \\t]*$`)
    return { closed: closePattern.test(mathSource), dollarLen }
  }
  return { closed: true, dollarLen: 0 }
}

const findStandaloneDollarClose = (text: string, dollarLen: number): number | null => {
  const pattern = new RegExp(`^[ \\t]*\\${'$'}{${dollarLen},}[ \\t]*(?=\\r|\\n|$)`, 'm')
  const match = pattern.exec(text)
  return match ? match.index + match[0].length : null
}

// 修复两类公式解析异常：
// 1. 容器（列表/引用）内公式起始行有缩进/引用前缀，但后续公式体或闭合定界符退回外层，导致公式提前截断并暴露源码和孤立 `]`
// 2. `\]` 同行紧跟标点或文字（如 `\]。`），导致 micromark-extension-llm-math 把后续文本吞进公式块
function repairMathBlocks(input: string, ast: Root): string {
  const edits: TextEdit[] = []
  let cursor = 0

  const addEdit = (edit: TextEdit) => {
    if (edit.start >= cursor && edit.end >= edit.start) {
      edits.push(edit)
      cursor = edit.end
    }
  }

  const visit = (parent: Root | Parent) => {
    for (let index = 0; index < parent.children.length; index++) {
      const node = parent.children[index]

      if (node.type === 'math') {
        const start = node.position?.start.offset
        const end = node.position?.end.offset
        if (start !== undefined && end !== undefined) {
          const mathSource = input.slice(start, end)
          if (mathSource.startsWith('\\[')) {
            const trimmed = mathSource.replace(/[ \t]+$/, '')
            const hasTailClose =
              trimmed.length >= 4 &&
              trimmed.endsWith('\\]') &&
              !isEscaped(trimmed, trimmed.length - 2)
            const scanLimit = hasTailClose ? trimmed.length - 2 : mathSource.length
            const inner = findUnescapedClosingBracket(mathSource.slice(0, scanLimit), 2, false)
            if (inner && inner.trailingText) {
              const lineStart = findLineStart(input, start)
              const contPrefix = toContinuationPrefix(input.slice(lineStart, start))
              const splitAt = start + inner.index + 2
              addEdit({
                start: splitAt,
                end: splitAt,
                replacement: detectNewline(input, start) + contPrefix,
              })
            }
          }
        }
        continue
      }

      if (node.type === 'list' || node.type === 'listItem' || node.type === 'blockquote') {
        visit(node)
      }

      if (node.type !== 'list' && node.type !== 'blockquote') {
        continue
      }
      const next = parent.children[index + 1]
      if (!next) {
        continue
      }

      const tail = getDeepestTrailingChild(node)
      if (tail?.type !== 'math') {
        continue
      }

      const openOffset = tail.position?.start.offset
      const mathEnd = tail.position?.end.offset
      const nextOffset = next.position?.start.offset
      if (openOffset === undefined || mathEnd === undefined || nextOffset === undefined) {
        continue
      }

      const mathSource = input.slice(openOffset, mathEnd)
      const { closed, dollarLen } = isMathClosed(mathSource)
      if (closed) {
        continue
      }

      const gap = input.slice(mathEnd, nextOffset)
      if (!/^[ \t]*(?:\r\n?|\n)[ \t\r\n]*$/.test(gap)) {
        continue
      }
      const firstLineBreak = /[ \t]*(\r\n?|\n)/.exec(gap)
      if (!firstLineBreak) {
        continue
      }
      const firstLineStart = mathEnd + firstLineBreak.index + firstLineBreak[0].length

      let closeEnd: number | undefined
      let splitAfterClose = false
      const limit = Math.min(parent.children.length, index + 9)
      for (let j = index + 1; j < limit; j++) {
        const sibling = parent.children[j]
        if (
          sibling.type === 'code' ||
          sibling.type === 'heading' ||
          sibling.type === 'table' ||
          sibling.type === 'thematicBreak'
        ) {
          break
        }
        const siblingStart = sibling.position?.start.offset
        const siblingEnd = sibling.position?.end.offset
        if (siblingStart === undefined || siblingEnd === undefined) {
          break
        }
        const siblingRaw = input.slice(siblingStart, siblingEnd)
        if (dollarLen === 0) {
          if (sibling.type === 'math' && siblingRaw.startsWith('\\[')) {
            break
          }
          const found = findUnescapedClosingBracket(siblingRaw, 0, true)
          if (found) {
            if (found.trailingText) {
              closeEnd = siblingStart + found.index + 2
              splitAfterClose = true
            } else {
              closeEnd = siblingStart + found.lineEndOffset
            }
            break
          }
        } else {
          if (
            sibling.type === 'math' &&
            new RegExp(`^\\${'$'}{${dollarLen},}$`).test(siblingRaw.trim())
          ) {
            closeEnd = siblingEnd
            break
          }
          const foundEnd = findStandaloneDollarClose(siblingRaw, dollarLen)
          if (foundEnd !== null) {
            closeEnd = siblingStart + foundEnd
            break
          }
        }
      }

      if (closeEnd === undefined || firstLineStart > closeEnd) {
        continue
      }

      const openLineStart = findLineStart(input, openOffset)
      const contPrefix = toContinuationPrefix(input.slice(openLineStart, openOffset))
      const lastGt = contPrefix.lastIndexOf('>')
      const blankLinePrefix = lastGt >= 0 ? contPrefix.slice(0, lastGt + 1) : ''
      let replacement = indentBlockLines(
        input.slice(firstLineStart, closeEnd),
        contPrefix,
        blankLinePrefix
      )
      if (splitAfterClose) {
        replacement += detectNewline(input, openOffset) + contPrefix
      }
      addEdit({ start: firstLineStart, end: closeEnd, replacement })
    }
  }

  visit(ast)
  if (edits.length === 0) {
    return input
  }
  const parts: string[] = []
  let pos = 0
  for (const edit of edits) {
    parts.push(input.slice(pos, edit.start), edit.replacement)
    pos = edit.end
  }
  parts.push(input.slice(pos))
  return parts.join('')
}

/**
 * 解析正文，并把渲染器不单独处理的节点提前换掉，渲染时无需再读原文：
 * - 传入 sources 时，[citation:N] 换成角标节点，找不到来源的直接去掉
 * - disableLink 时链接只保留文字
 * - 删除线保留原样的 ~ 定界符，脚注、引用式链接与定义显示原文
 */
export function toMdAst(input: string, { sources, disableLink }: MarkdownParseOptions): Root {
  let ast = fromMarkdown(input, parserOptions)
  if (input.includes('\\[') || input.includes('$$')) {
    for (let pass = 0; pass < MAX_MATH_REPAIR_PASSES; pass++) {
      const repaired = repairMathBlocks(input, ast)
      if (repaired === input) {
        break
      }
      input = repaired
      ast = fromMarkdown(input, parserOptions)
    }
  }
  if (sources) {
    const sourcesByIndex = new Map(sources.map((source) => [source.index, source]))
    findAndReplace(
      ast,
      [
        /\[citation:(\d+)\]/g,
        (_: string, index: string): CitationNode | '' => {
          const source = sourcesByIndex.get(Number(index))
          return source ? { type: 'citation', source } : ''
        },
      ],
      { ignore: ['linkReference'] }
    )
  }
  const raw = (node: Nodes) => input.slice(node.position?.start.offset, node.position?.end.offset)
  // 先处理子节点，再按需把当前节点换成若干节点
  const simplify = (node: Nodes): Nodes[] => {
    if ('children' in node) {
      ;(node as Parent).children = node.children.flatMap(simplify) as RootContent[]
    }
    switch (node.type) {
      case 'link':
        return disableLink ? node.children : [node]
      case 'delete': {
        // 解析器保证首尾定界符等长
        const delimiter = raw(node).match(/^~+/)?.[0] ?? ''
        return [text(delimiter), ...node.children, text(delimiter)]
      }
      case 'footnoteReference':
      case 'imageReference':
      case 'linkReference':
        return [text(raw(node))]
      case 'footnoteDefinition':
      case 'definition':
        return [{ type: 'paragraph', children: [text(raw(node))] }]
      default:
        return [node]
    }
  }
  simplify(ast)
  return ast
}
