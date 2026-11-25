import { readBlobBuffer } from '../../utils/blob.js'
import type { ChatApiFormat } from '../api/chatConfig.js'
import { ApiError } from '../api/client.js'
import type { InlineFileBlockParam, TextBlockParam } from '../api/types.js'
import { getFileExt } from '../attachments.js'
import { prepareImageUpload } from '../imageUpload.js'
import { readPlainText } from './contextSummary.js'
import { getContextRounds } from './reply.js'
import type { FileAttachment, Message, UserMessage } from './types.js'
import {
  attachmentPreprocessCache,
  estimateAttachmentBlocksBytes,
  type ProcessedAttachmentBlock,
} from '../../elsewhere/attachments/cache.js'
import {
  computeLongImageSlices,
  longImageSliceIntro,
  sliceLongImageBlob,
} from '../../elsewhere/attachments/longImage.js'
import { decidePdfMode, extractPdf, type PdfLocalMode } from '../../elsewhere/attachments/pdfExtract.js'
import { probeImageFile } from '../../elsewhere/attachments/probe.js'
import type { AttachmentProgressItem } from '../../elsewhere/attachments/progress.js'
import { useElsewherePrefs } from '../../elsewhere/preferences.js'

type CustomAttachment = InlineFileBlockParam | TextBlockParam

const toBase64 = async (blob: Blob, signal: AbortSignal) => {
  const chunks: string[] = []
  const size = 24_576
  for (let offset = 0; offset < blob.size; offset += size) {
    signal.throwIfAborted()
    const part = new Uint8Array(await readBlobBuffer(blob.slice(offset, offset + size)))
    chunks.push(btoa(String.fromCharCode(...part)))
  }
  return chunks.join('')
}

const imageBlock = async (blob: Blob, signal: AbortSignal): Promise<InlineFileBlockParam> => ({
  type: 'image',
  source: {
    type: 'base64',
    media_type: blob.type || 'image/png',
    data: await toBase64(blob, signal),
  },
})

const cacheBlocks = (
  key: string,
  blocks: ProcessedAttachmentBlock[],
  extra?: { nativePdf?: boolean; truncated?: { totalPages: number; renderedPages: number } }
) => {
  const entry = { blocks, bytes: estimateAttachmentBlocksBytes(blocks), ...extra }
  attachmentPreprocessCache.set(key, entry)
  return entry
}

const prepareImageBlocks = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  onProgress?: (item: AttachmentProgressItem | null) => void
): Promise<CustomAttachment[] | undefined> => {
  const prefs = useElsewherePrefs.getState()
  const probe = await probeImageFile(blob)
  const dimensions =
    probe?.width && probe.height ? { width: probe.width, height: probe.height } : undefined
  const slices = dimensions ? computeLongImageSlices(dimensions.width, dimensions.height) : []
  const shouldSlice =
    slices.length > 0 &&
    (file.customMode === 'slice' || (file.customMode !== 'original' && prefs.sliceLongImage))
  if (shouldSlice && dimensions) {
    const key = `${file.id}:slice`
    const cached = attachmentPreprocessCache.get(key)
    if (cached) {return cached.blocks}
    const cut = await sliceLongImageBlob(blob, slices, signal, (current, total) =>
      onProgress?.({ kind: 'slice', current, total })
    )
    onProgress?.(null)
    if (cut?.length) {
      const vertical = dimensions.height >= dimensions.width
      const blocks: CustomAttachment[] = [
        { type: 'text', text: longImageSliceIntro(file, cut.length, vertical) },
      ]
      for (const part of cut) {
        blocks.push(await imageBlock(part, signal))
      }
      return cacheBlocks(key, blocks).blocks
    }
  }

  const original = new File([blob], file.name, { type: file.mimeType || blob.type })
  const { file: image } = await prepareImageUpload(original, signal, 4096, true)
  if (image && /^image\/(jpeg|png|gif|webp)$/.test(image.type)) {
    return [await imageBlock(image, signal)]
  }
  return undefined
}

const nativePdfBlock = async (
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal
): Promise<InlineFileBlockParam> => ({
  type: 'document',
  title: file.name,
  source: { type: 'base64', media_type: 'application/pdf', data: await toBase64(blob, signal) },
})

const preparePdfBlocks = async (
  format: ChatApiFormat,
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  forceLocal: boolean,
  onProgress?: (item: AttachmentProgressItem | null) => void
): Promise<{
  blocks: CustomAttachment[] | undefined
  nativePdf: boolean
  truncated?: { totalPages: number; renderedPages: number }
}> => {
  const prefs = useElsewherePrefs.getState()
  const mode: PdfLocalMode = forceLocal
    ? file.customMode === 'pdf_text'
      ? 'text'
      : file.customMode === 'pdf_images'
        ? 'images'
        : 'smart'
    : decidePdfMode({
        format,
        preference: prefs.customPdfMode,
        customMode: file.customMode,
        size: blob.size,
      })
  const key = `${file.id}:pdf_${mode}`
  const cached = attachmentPreprocessCache.get(key)
  if (cached) {
    return { blocks: cached.blocks, nativePdf: cached.nativePdf === true, truncated: cached.truncated }
  }
  if (mode === 'native') {
    const blocks = [await nativePdfBlock(file, blob, signal)]
    const entry = cacheBlocks(key, blocks, { nativePdf: true })
    return { blocks: entry.blocks, nativePdf: true }
  }

  const extracted = await extractPdf(blob, file.name, mode, signal, onProgress)
  const blocks: CustomAttachment[] = []
  if (extracted.text?.trim()) {
    blocks.push({ type: 'text', text: extracted.text })
  }
  if (extracted.images.length > 0) {
    blocks.push({
      type: 'text',
      text: `Rendered pages from ${file.name} (pages: ${extracted.renderedPages.join(', ')}):`,
    })
    for (const image of extracted.images) {
      blocks.push(await imageBlock(image.blob, signal))
    }
  }
  const truncated =
    extracted.truncatedPages > 0
      ? {
          totalPages: extracted.truncatedPages + extracted.renderedPages.length,
          renderedPages: extracted.renderedPages.length,
        }
      : undefined
  const entry = cacheBlocks(key, blocks, { truncated })
  return { blocks: entry.blocks, nativePdf: false, truncated }
}

const toInlineBlocks = async (
  format: ChatApiFormat,
  file: FileAttachment,
  blob: Blob,
  signal: AbortSignal,
  forceLocalPdf: boolean,
  onProgress?: (item: AttachmentProgressItem | null) => void
): Promise<{
  blocks: CustomAttachment[] | undefined
  nativePdf?: boolean
  truncated?: { totalPages: number; renderedPages: number }
}> => {
  if (file.isImage) {
    return { blocks: await prepareImageBlocks(file, blob, signal, onProgress) }
  }
  const extension = getFileExt(file.name)
  if (extension === 'pdf') {
    return preparePdfBlocks(format, file, blob, signal, forceLocalPdf, onProgress)
  }
  const text =
    extension === 'docx' || extension === 'pptx' || extension === 'xlsx'
      ? await import('./officeText.js').then(({ readOfficeText }) =>
          readOfficeText(extension, blob, signal)
        )
      : await readPlainText(file, async () => blob)
  return { blocks: text === undefined ? undefined : [{ type: 'text', text: `${file.name}\n${text}` }] }
}

export type PrepareCustomAttachmentsResult = {
  inline: Map<string, CustomAttachment[]>
  nativePdfIds: Set<string>
  truncations: Array<{ name: string; totalPages: number; renderedPages: number }>
}

export const prepareCustomAttachments = async (
  format: ChatApiFormat,
  history: Message[],
  question: UserMessage,
  loadFile: (id: string) => Promise<Blob | undefined>,
  signal: AbortSignal,
  options?: {
    forceLocalPdfIds?: ReadonlySet<string>
    onProgress?: (item: AttachmentProgressItem | null) => void
  }
): Promise<PrepareCustomAttachmentsResult> => {
  const inline = new Map<string, CustomAttachment[]>()
  const nativePdfIds = new Set<string>()
  const truncations: PrepareCustomAttachmentsResult['truncations'] = []
  for (const user of [...getContextRounds(history).map(([user]) => user), question]) {
    const blocks: CustomAttachment[] = []
    for (const file of user.files) {
      signal.throwIfAborted()
      const blob = await loadFile(file.id)
      const prepared = blob
        ? await toInlineBlocks(
            format,
            file,
            blob,
            signal,
            options?.forceLocalPdfIds?.has(file.id) === true,
            options?.onProgress
          )
        : { blocks: undefined }
      if (prepared.blocks?.length) {
        blocks.push(...prepared.blocks)
        if (prepared.nativePdf) {nativePdfIds.add(file.id)}
        if (prepared.truncated) {
          truncations.push({ name: file.name, ...prepared.truncated })
        }
      } else if (user === question) {
        throw new ApiError('protocol', {
          key: 'advancedAttachmentUnsupported',
          params: { name: file.name },
        })
      }
    }
    inline.set(user.id, blocks)
  }
  return { inline, nativePdfIds, truncations }
}
