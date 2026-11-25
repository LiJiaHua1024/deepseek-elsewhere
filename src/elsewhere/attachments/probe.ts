import { computeLongImageSlices, isLongImageDimensions } from './longImage.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { getFileExt } from '../../services/attachments.js'
import { probePdfPageCount } from './pdfExtract.js'

export type AttachmentProbe = NonNullable<DraftAttachment['probe']>

const probeImageDimensions = (blob: Blob): Promise<{ width: number; height: number } | null> =>
  new Promise((resolve) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: image.naturalWidth, height: image.naturalHeight })
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    image.src = url
  })

export const probeImageFile = async (blob: Blob): Promise<AttachmentProbe | null> => {
  const dimensions = await probeImageDimensions(blob).catch(() => null)
  if (!dimensions) {return null}
  const slices = computeLongImageSlices(dimensions.width, dimensions.height)
  return {
    width: dimensions.width,
    height: dimensions.height,
    ...(isLongImageDimensions(dimensions.width, dimensions.height)
      ? { estimatedSlices: Math.max(1, slices.length) }
      : {}),
  }
}

export const probeAttachment = async (attachment: DraftAttachment): Promise<AttachmentProbe | null> => {
  const blob = attachment.file ?? attachment.blob
  if (!blob) {return null}
  if (attachment.isImage) {return probeImageFile(blob)}
  if (getFileExt(attachment.name) === 'pdf') {
    const pageCount = await probePdfPageCount(blob)
    return pageCount === undefined ? null : { pageCount }
  }
  return null
}
