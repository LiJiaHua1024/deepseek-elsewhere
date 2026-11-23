import { readBlobBuffer } from '../../utils/blob.js'
import type { ToolFileAttachment } from '../tools/types.js'
import { PYTHON_MAX_FILE_BYTES } from './config.js'

const MOUNTABLE_EXTS = new Set([
  'csv',
  'tsv',
  'json',
  'jsonl',
  'txt',
  'md',
  'markdown',
  'xml',
  'yaml',
  'yml',
  'log',
  'py',
  'sql',
  'ini',
  'cfg',
  'conf',
  'toml',
  'html',
  'htm',
  'css',
  'js',
  'ts',
  'sh',
])

const fileExtension = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isMountablePythonAttachment = (
  file: Pick<ToolFileAttachment, 'name' | 'size' | 'isImage'>
): boolean => {
  if (file.isImage || file.size > PYTHON_MAX_FILE_BYTES) {
    return false
  }
  return MOUNTABLE_EXTS.has(fileExtension(file.name))
}

export const sanitizeMountFilename = (rawName: string, used: Set<string>): string => {
  const base = rawName.split(/[\\/]/).pop() ?? 'file.txt'
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '') || 'file.txt'
  let candidate = cleaned
  let counter = 1
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot) : ''
  while (used.has(candidate)) {
    candidate = `${stem}_${counter}${ext}`
    counter += 1
  }
  used.add(candidate)
  return candidate
}

export type MountedPythonFile = {
  name: string
  originalName: string
  data: Uint8Array
}

export const filterMountableAttachments = (
  attachments: readonly ToolFileAttachment[]
): { id: string; mountName: string; originalName: string }[] => {
  const used = new Set<string>()
  const result: { id: string; mountName: string; originalName: string }[] = []
  for (const file of attachments) {
    if (!isMountablePythonAttachment(file)) {
      continue
    }
    const mountName = sanitizeMountFilename(file.name, used)
    result.push({ id: file.id, mountName, originalName: file.name })
  }
  return result
}

export const collectPythonMountFiles = async (
  attachments: readonly ToolFileAttachment[] | undefined,
  loadFile: ((id: string) => Promise<Blob | undefined>) | undefined,
  signal?: AbortSignal
): Promise<MountedPythonFile[]> => {
  if (!attachments?.length || !loadFile) {
    return []
  }
  const targets = filterMountableAttachments(attachments)
  const mounted: MountedPythonFile[] = []
  for (const target of targets) {
    signal?.throwIfAborted()
    const blob = await loadFile(target.id)
    if (!blob || blob.size > PYTHON_MAX_FILE_BYTES) {
      continue
    }
    const buffer = await readBlobBuffer(blob)
    mounted.push({
      name: target.mountName,
      originalName: target.originalName,
      data: new Uint8Array(buffer),
    })
  }
  return mounted
}
