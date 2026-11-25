import { readBlobBuffer } from '../../utils/blob.js'
import type { ChatApiFormat } from '../../services/api/chatConfig.js'
import { ApiError } from '../../services/api/client.js'
import type { CustomAttachmentMode } from '../../services/chat/types.js'
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { AttachmentProgressItem } from './progress.js'

export const NATIVE_PDF_MAX_BYTES = 10 * 1024 * 1024
export const MAX_PDF_TEXT_CHARS = 120_000
export const MAX_PDF_RENDER_PAGES = 12
export const SCANNED_PAGE_MIN_CHARS = 30
const PDF_RENDER_WIDTH = 1280

export type PdfLocalMode = 'native' | 'text' | 'images' | 'smart'

export const decidePdfMode = ({
  format,
  preference,
  customMode,
  size,
}: {
  format: ChatApiFormat
  preference: 'auto' | 'local'
  customMode?: CustomAttachmentMode
  size: number
}): PdfLocalMode => {
  if (customMode === 'pdf_text') {return 'text'}
  if (customMode === 'pdf_images') {return 'images'}
  if (customMode === 'pdf_original' && format !== 'chat') {return 'native'}
  if (!customMode && format !== 'chat' && preference === 'auto' && size <= NATIVE_PDF_MAX_BYTES) {
    return 'native'
  }
  return 'smart'
}

export type PdfTextPage = { page: number; text: string }

type PdfImagePage = { page: number; blob: Blob }

export type PdfExtractionResult = {
  pageCount: number
  text?: string
  images: PdfImagePage[]
  renderedPages: number[]
  truncatedPages: number
}

export const normalizeLinePieces = (items: Array<{
  str: string
  transform: number[]
  width?: number
  height?: number
  hasEOL?: boolean
}>) => {
  type Piece = { x: number; y: number; end: number; size: number; str: string; hasEOL?: boolean }
  const rows = new Map<number, Piece[]>()
  for (const item of items) {
    if (!item.str) {continue}
    const x = item.transform[4] ?? 0
    const y = item.transform[5] ?? 0
    const size = Math.max(4, Math.abs(item.transform[3] ?? item.height ?? 10))
    const key = Math.round(y / Math.max(2, size * 0.35))
    const piece = {
      x,
      y,
      end: x + (item.width ?? item.str.length * size * 0.5),
      size,
      str: item.str,
      hasEOL: item.hasEOL,
    }
    const row = rows.get(key)
    if (row) {row.push(piece)}
    else {rows.set(key, [piece])}
  }
  return [...rows.entries()]
    .sort((a, b) => {
      const ay = a[1][0]?.y ?? 0
      const by = b[1][0]?.y ?? 0
      return by - ay
    })
    .flatMap(([, row]) => {
      row.sort((a, b) => a.x - b.x)
      const lines = ['']
      let previous: Piece | undefined
      for (const piece of row) {
        const gap = previous ? piece.x - previous.end : 0
        const needsSpace =
          previous &&
          gap > Math.max(1.5, previous.size * 0.22) &&
          !lines.at(-1)?.endsWith(' ') &&
          !/^\s/.test(piece.str)
        lines[lines.length - 1] += `${needsSpace ? ' ' : ''}${piece.str}`
        previous = piece
        if (piece.hasEOL) {lines.push('')}
      }
      return lines.map((line) => line.replace(/[\t ]+$/u, '')).filter(Boolean)
    })
    .filter(Boolean)
    .join('\n')
}

const escapeAttribute = (value: string) =>
  value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')

export const buildPdfAttachmentText = (
  name: string,
  pageCount: number,
  pages: PdfTextPage[]
): { text: string; truncatedAtPage?: number } => {
  const chunks: string[] = []
  let length = 0
  let truncatedAtPage: number | undefined
  for (const page of pages) {
    const pageText = page.text.trim()
    if (!pageText) {continue}
    const part = `[第 ${page.page} 页]\n${pageText}\n`
    if (length + part.length > MAX_PDF_TEXT_CHARS) {
      const remaining = MAX_PDF_TEXT_CHARS - length
      const cut = part.slice(0, Math.max(0, remaining))
      const newline = cut.lastIndexOf('\n')
      const safe = newline > 0 ? cut.slice(0, newline + 1) : cut
      if (safe) {chunks.push(safe)}
      truncatedAtPage = page.page
      break
    }
    chunks.push(part)
    length += part.length
  }
  const suffix = truncatedAtPage
    ? `[已截断，仅保留前 ${Math.max(0, truncatedAtPage - 1)} 页文字，共 ${pageCount} 页]\n`
    : ''
  return {
    text: chunks.length
      ? `<attachment name="${escapeAttribute(name)}" pages="${pageCount}">\n${chunks.join('')}${suffix}</attachment>`
      : '',
    truncatedAtPage,
  }
}

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
let pdfjsPromise: Promise<PdfJs> | undefined
let mainThreadWorkerPromise: Promise<unknown> | undefined
let realWorkerPromise: Promise<Worker | null> | undefined
let cachedPdfWorker: InstanceType<PdfJs['PDFWorker']> | null | undefined

const loadPdfJs = () => (pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs'))

const loadMainThreadWorker = () =>
  (mainThreadWorkerPromise ??= import('pdfjs-dist/legacy/build/pdf.worker.min.mjs').then((worker) => {
    ;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker
    return worker
  }))

const createRealWorker = () =>
  (realWorkerPromise ??= new Promise<Worker | null>((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(null)
      return
    }
    let worker: Worker
    try {
      worker = new Worker(
        new URL(/* webpackChunkName: "pdfjs-worker" */ './pdfjsWorkerEntry.ts', import.meta.url)
      )
    } catch {
      resolve(null)
      return
    }
    const timer = setTimeout(() => finish(null), 2500)
    const finish = (ready: Worker | null) => {
      clearTimeout(timer)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      if (!ready) {worker.terminate()}
      resolve(ready)
    }
    const onError = () => finish(null)
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { sourceName?: string; targetName?: string; action?: string }
      if (data?.sourceName === 'worker' && data.targetName === 'main' && data.action === 'ready') {
        finish(worker)
      }
    }
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
  }))

const cmapUrl = () => {
  if (typeof document === 'undefined') {return undefined}
  return new URL('static/pdfjs/cmaps/', document.baseURI).toString()
}

const openPdf = async (blob: Blob, signal: AbortSignal) => {
  const pdfjs = await loadPdfJs()
  signal.throwIfAborted()
  if (cachedPdfWorker === undefined) {
    const port = await createRealWorker()
    cachedPdfWorker = port ? pdfjs.PDFWorker.fromPort({ port }) : null
    if (!port) {await loadMainThreadWorker()}
  }
  const data = new Uint8Array(await readBlobBuffer(blob))
  signal.throwIfAborted()
  return pdfjs.getDocument({
    data,
    cMapUrl: cmapUrl(),
    cMapPacked: true,
    ...(cachedPdfWorker ? { worker: cachedPdfWorker } : {}),
    useWorkerFetch: false,
    isEvalSupported: false,
  })
}

const encodeCanvas = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
  new Promise((resolve) => {
    canvas.toBlob((webp) => {
      if (webp?.type === 'image/webp') {
        resolve(webp)
      } else {
        canvas.toBlob((png) => resolve(png ?? webp), 'image/png')
      }
    }, 'image/webp', 0.85)
  })

const renderPage = async (page: PDFPageProxy, signal: AbortSignal) => {
  const first = page.getViewport({ scale: 1 })
  const viewport = page.getViewport({ scale: PDF_RENDER_WIDTH / first.width })
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(viewport.width))
  canvas.height = Math.max(1, Math.round(viewport.height))
  try {
    const context = canvas.getContext('2d')
    if (!context) {throw new Error('Canvas unavailable')}
    await page.render({ canvasContext: context, viewport }).promise
    signal.throwIfAborted()
    return await encodeCanvas(canvas)
  } finally {
    canvas.width = canvas.height = 0
  }
}

export const probePdfPageCount = async (blob: Blob): Promise<number | undefined> => {
  try {
    const task = await openPdf(blob, new AbortController().signal)
    const pdf = await task.promise
    const count = pdf.numPages
    await task.destroy().catch(() => {})
    return count
  } catch {
    return undefined
  }
}

export const extractPdf = async (
  blob: Blob,
  name: string,
  mode: Exclude<PdfLocalMode, 'native'>,
  signal: AbortSignal,
  onProgress?: (item: AttachmentProgressItem | null) => void
): Promise<PdfExtractionResult> => {
  if (typeof document === 'undefined') {
    throw new Error('PDF extraction requires a browser document')
  }
  let loadingTask: Awaited<ReturnType<typeof openPdf>> | undefined
  try {
    loadingTask = await openPdf(blob, signal)
    const documentTask = loadingTask
    const pdf = await documentTask.promise
    signal.throwIfAborted()
    const pageCount = pdf.numPages
    const pages: PdfTextPage[] = []
    const scannedPages: number[] = []
    const renderAll = mode === 'images'
    if (mode !== 'images') {
      onProgress?.({ kind: 'pdf_text' })
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
        signal.throwIfAborted()
        const page = await pdf.getPage(pageNumber)
        const content = await page.getTextContent()
        const text = normalizeLinePieces(content.items)
        pages.push({ page: pageNumber, text })
        if (mode === 'smart' && text.replace(/\s/gu, '').length < SCANNED_PAGE_MIN_CHARS) {
          scannedPages.push(pageNumber)
        }
      }
    }
    const renderCandidates = renderAll
      ? Array.from({ length: pageCount }, (_, index) => index + 1)
      : scannedPages
    const renderPages = renderCandidates.slice(0, MAX_PDF_RENDER_PAGES)
    const images: PdfImagePage[] = []
    const renderedPages: number[] = []
    for (const [index, pageNumber] of renderPages.entries()) {
      signal.throwIfAborted()
      onProgress?.({ kind: 'pdf_render', current: index + 1, total: renderPages.length })
      const page = await pdf.getPage(pageNumber)
      const image = await renderPage(page, signal)
      if (image) {
        images.push({ page: pageNumber, blob: image })
        renderedPages.push(pageNumber)
      }
    }
    const built = mode === 'images' ? undefined : buildPdfAttachmentText(name, pageCount, pages)
    return {
      pageCount,
      text: built?.text,
      images,
      renderedPages,
      truncatedPages: Math.max(0, renderCandidates.length - renderPages.length),
    }
  } catch (error) {
    if (signal.aborted) {throw error}
    if (error instanceof Error && error.message === 'Canvas unavailable') {throw error}
    throw new ApiError('protocol', '无法解析此 PDF（文件可能已加密或损坏）')
  } finally {
    onProgress?.(null)
    await loadingTask?.destroy().catch(() => {})
  }
}

export const isNativePdfRejectionError = (error: unknown) => {
  if (!(error instanceof ApiError) || error.kind !== 'http') {return false}
  if (error.status === 413) {return true}
  if (error.status !== 400 && error.status !== 422) {return false}
  return /pdf|document|file|media_type|unsupported|too\s+large/i.test(error.message)
}
