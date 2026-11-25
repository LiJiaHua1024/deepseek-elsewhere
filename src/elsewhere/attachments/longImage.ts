import type { FileAttachment } from '../../services/chat/types.js'

export const LONG_IMAGE_MIN_RATIO = 2.6
export const LONG_IMAGE_MIN_EDGE = 2800
export const MAX_SHORT_EDGE = 1536
export const MAX_SLICES = 10

export type LongImageSlice = {
  sx: number
  sy: number
  sw: number
  sh: number
  outWidth: number
  outHeight: number
}

export const isLongImageDimensions = (width: number, height: number) =>
  (height / width > LONG_IMAGE_MIN_RATIO && height > LONG_IMAGE_MIN_EDGE) ||
  (width / height > LONG_IMAGE_MIN_RATIO && width > LONG_IMAGE_MIN_EDGE)

/** 纯数学切片规划：在缩放后的长边上均匀切片，源坐标按比例映射回原图。 */
export const computeLongImageSlices = (
  naturalWidth: number,
  naturalHeight: number
): LongImageSlice[] => {
  if (
    !Number.isFinite(naturalWidth) ||
    !Number.isFinite(naturalHeight) ||
    naturalWidth <= 0 ||
    naturalHeight <= 0 ||
    !isLongImageDimensions(naturalWidth, naturalHeight)
  ) {
    return []
  }
  const vertical = naturalHeight >= naturalWidth
  const shortEdge = vertical ? naturalWidth : naturalHeight
  const longEdge = vertical ? naturalHeight : naturalWidth
  const scale = Math.min(1, MAX_SHORT_EDGE / shortEdge)
  const scaledShort = Math.max(1, Math.round(shortEdge * scale))
  const scaledLong = Math.max(1, Math.round(longEdge * scale))
  const overlap = Math.round(Math.min(100, Math.max(64, scaledShort * 0.08)))
  const baseSliceLong = Math.max(960, Math.min(2048, Math.round(scaledShort * 1.5)))

  let count = Math.max(1, Math.ceil((scaledLong - overlap) / Math.max(1, baseSliceLong - overlap)))
  let sliceLong = baseSliceLong
  if (count > MAX_SLICES) {
    count = MAX_SLICES
    sliceLong = Math.ceil((scaledLong + overlap * (MAX_SLICES - 1)) / MAX_SLICES)
  }
  const step = Math.max(1, sliceLong - overlap)
  const slices: LongImageSlice[] = []
  for (let index = 0; index < count; index++) {
    const start = index * step
    if (start >= scaledLong) {
      break
    }
    const length = Math.min(sliceLong, scaledLong - start)
    if (length <= 0) {
      break
    }
    const longStart = (start / scaledLong) * longEdge
    const longLength = (length / scaledLong) * longEdge
    if (vertical) {
      slices.push({
        sx: 0,
        sy: longStart,
        sw: naturalWidth,
        sh: index === count - 1 ? naturalHeight - longStart : longLength,
        outWidth: scaledShort,
        outHeight: length,
      })
    } else {
      slices.push({
        sx: longStart,
        sy: 0,
        sw: index === count - 1 ? naturalWidth - longStart : longLength,
        sh: naturalHeight,
        outWidth: length,
        outHeight: scaledShort,
      })
    }
  }
  return slices
}

const loadBitmap = async (blob: Blob): Promise<ImageBitmap | HTMLImageElement> => {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob)
  }
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

const encodeCanvas = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => {
    const finish = (blob: Blob | null) => {
      if (blob && blob.type === 'image/webp') {
        resolve(blob)
        return
      }
      canvas.toBlob((png) => resolve(png ?? blob), 'image/png')
    }
    canvas.toBlob(finish, 'image/webp', 0.88)
  })

/** 逐片绘制并立即释放画布；解码或编码失败时返回 null，由调用方回退原图。 */
export const sliceLongImageBlob = async (
  blob: Blob,
  slices: LongImageSlice[],
  signal: AbortSignal,
  onProgress?: (current: number, total: number) => void
): Promise<Blob[] | null> => {
  if (slices.length === 0 || typeof document === 'undefined') {
    return null
  }
  try {
    const source = await loadBitmap(blob)
    const output: Blob[] = []
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    try {
      context.imageSmoothingQuality = 'high'
      for (const [index, slice] of slices.entries()) {
        signal.throwIfAborted()
        canvas.width = Math.max(1, Math.round(slice.outWidth))
        canvas.height = Math.max(1, Math.round(slice.outHeight))
        context.drawImage(
          source,
          slice.sx,
          slice.sy,
          slice.sw,
          slice.sh,
          0,
          0,
          canvas.width,
          canvas.height
        )
        const encoded = await encodeCanvas(canvas)
        signal.throwIfAborted()
        if (!encoded) {
          return null
        }
        output.push(encoded)
        onProgress?.(index + 1, slices.length)
      }
      return output
    } finally {
      canvas.width = canvas.height = 0
      if ('close' in source && typeof source.close === 'function') {
        source.close()
      }
    }
  } catch {
    return null
  }
}

export const longImageSliceIntro = (file: Pick<FileAttachment, 'name'>, count: number, vertical: boolean) =>
  `The following ${count} images are consecutive ${vertical ? 'top-to-bottom' : 'left-to-right'} slices of ${file.name} with slight overlap along adjacent edges.`
