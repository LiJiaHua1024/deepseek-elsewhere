import type { MemoryWriteMode, MemoryWriteResult } from './types.js'
import {
  normalizeFactLine,
  normalizeMemoryPath,
  normalizeNewlines,
  withSourceSuffix,
} from './store.js'

export type MemoryMutationResult =
  | { ok: true; result: MemoryWriteResult; nextContent: string }
  | { ok: false; message: string }

const ensureLineEnd = (text: string) => (text.endsWith('\n') ? text : `${text}\n`)

const appendBlock = (content: string, text: string): string => {
  const line = withSourceSuffix(text)
  if (!line) {
    return content
  }
  const bullet = line.startsWith('- ') ? line : `- ${line}`
  const base = content.trimEnd()
  if (!base) {
    return `${bullet}\n`
  }
  return `${base}\n${bullet}\n`
}

const renderLineDiff = (before: string, after: string) => {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const output: string[] = []
  let index = 0
  while (index < Math.max(beforeLines.length, afterLines.length)) {
    const oldLine = beforeLines[index]
    const newLine = afterLines[index]
    if (oldLine === newLine) {
      index += 1
      continue
    }
    if (oldLine !== undefined && oldLine !== '') {
      output.push(`- ${oldLine}`)
    }
    if (newLine !== undefined && newLine !== '') {
      output.push(`+ ${newLine}`)
    }
    index += 1
  }
  return output.length > 0 ? output.join('\n') : '(内容不变)'
}

export const mutateMemoryContent = ({
  path: rawPath,
  mode,
  content: originalContent,
  text,
  oldText,
  newText,
  allowCreateIndex = false,
}: {
  path: string
  mode: MemoryWriteMode
  content: string | null
  text?: string
  oldText?: string
  newText?: string
  allowCreateIndex?: boolean
}): MemoryMutationResult => {
  const path = normalizeMemoryPath(rawPath)
  if (!path) {
    return { ok: false, message: '路径无效' }
  }
  if (path === 'MEMORY.md' && mode === 'create' && originalContent !== null && !allowCreateIndex) {
    return { ok: false, message: 'MEMORY.md 已存在' }
  }
  const current = normalizeNewlines(originalContent ?? '')

  if (mode === 'create') {
    if (originalContent !== null) {
      return { ok: false, message: '笔记已存在，未覆盖' }
    }
    const body = normalizeNewlines(text ?? '')
    const nextContent = ensureLineEnd(body)
    return {
      ok: true,
      nextContent,
      result: {
        path,
        changed: true,
        message: '笔记已创建',
        diffText: nextContent
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => `+ ${line}`)
          .join('\n'),
      },
    }
  }

  if (originalContent === null) {
    return { ok: false, message: '笔记不存在' }
  }

  if (mode === 'append') {
    const normalizedFact = normalizeFactLine(text ?? '')
    if (!normalizedFact) {
      return { ok: false, message: '没有可写入的内容' }
    }
    const duplicated = current
      .split('\n')
      .some((line) => normalizeFactLine(line) === normalizedFact)
    if (duplicated) {
      return {
        ok: true,
        nextContent: current,
        result: { path, changed: false, message: '这条内容已经存在', diffText: '(内容不变)' },
      }
    }
    const nextContent = appendBlock(current, text ?? '')
    return {
      ok: true,
      nextContent,
      result: {
        path,
        changed: true,
        message: '记忆已追加',
        diffText: renderLineDiff(current, nextContent),
      },
    }
  }

  if (mode === 'replace') {
    if (!oldText) {
      return { ok: false, message: '缺少要替换的原文' }
    }
    if (!current.includes(oldText)) {
      return { ok: false, message: '未找到完全一致的原内容，未修改' }
    }
    const nextContent = current.replace(oldText, newText ?? '')
    return {
      ok: true,
      nextContent,
      result: {
        path,
        changed: nextContent !== current,
        message: '记忆已更新',
        diffText: renderLineDiff(current, nextContent),
      },
    }
  }

  if (mode === 'delete_line') {
    const target = (text ?? oldText ?? '').trim()
    if (!target) {
      return { ok: false, message: '缺少要删除的行' }
    }
    const lines = current.split('\n')
    const removeIndexes = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line.trim() === target || normalizeFactLine(line) === normalizeFactLine(target))
      .map(({ index }) => index)
    if (removeIndexes.length === 0) {
      return { ok: false, message: '未找到完全一致的原内容，未修改' }
    }
    const nextContent = lines
      .filter((_, index) => !removeIndexes.includes(index))
      .join('\n')
    return {
      ok: true,
      nextContent,
      result: {
        path,
        changed: true,
        message: '记忆已删除',
        diffText: renderLineDiff(current, nextContent),
      },
    }
  }

  return { ok: false, message: '不支持的写入模式' }
}
