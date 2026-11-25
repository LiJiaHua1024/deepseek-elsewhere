declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  export const GlobalWorkerOptions: { workerSrc?: string; workerPort?: Worker | null }
  export type PDFDocumentProxy = {
    numPages: number
    getPage(pageNumber: number): Promise<PDFPageProxy>
    destroy(): Promise<void>
  }
  export type PDFPageProxy = {
    getTextContent(): Promise<TextContent>
    getViewport(params: { scale: number }): { width: number; height: number; scale: number }
    render(params: {
      canvasContext: CanvasRenderingContext2D
      viewport: { width: number; height: number; scale: number }
    }): { promise: Promise<void>; cancel(): void }
  }
  export type TextContent = {
    items: Array<{
      str: string
      transform: number[]
      width?: number
      height?: number
      hasEOL?: boolean
    }>
  }
  export type PDFLoadingTask = {
    promise: Promise<PDFDocumentProxy>
    destroy(): Promise<void>
  }
  export class PDFWorker {
    constructor(params?: { port?: Worker | null })
    static fromPort(params: { port: Worker }): PDFWorker
    destroy(): void
  }
  export function getDocument(params: {
    data?: Uint8Array
    password?: string
    cMapUrl?: string
    cMapPacked?: boolean
    worker?: PDFWorker
    useWorkerFetch?: boolean
    isEvalSupported?: boolean
    disableFontFace?: boolean
    verbosity?: number
  }): PDFLoadingTask
}

declare module 'pdfjs-dist/legacy/build/pdf.worker.min.mjs' {
  export const WorkerMessageHandler: unknown
}
