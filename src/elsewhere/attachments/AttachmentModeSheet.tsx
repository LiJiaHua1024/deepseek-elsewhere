import clsx from 'clsx'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { IconCheckOutline16 } from '../../components/base/icons.js'
import type { ChatApiFormat } from '../../services/api/chatConfig.js'
import type { CustomAttachmentMode } from '../../services/chat/types.js'
import type { DraftAttachment } from '../../services/chat/drafts.js'
import { useElsewherePrefs } from '../preferences.js'
import { useIsZh } from '../text.js'
import { NATIVE_PDF_MAX_BYTES } from './pdfExtract.js'
import styles from './AttachmentModeSheet.module.css'

type SheetProps = {
  kind: 'image' | 'pdf'
  attachment: DraftAttachment
  format: ChatApiFormat
  value?: CustomAttachmentMode
  onSelect: (mode?: CustomAttachmentMode) => void
  onPreview?: () => void
  onClose: () => void
}

const Option = ({
  title,
  description,
  selected,
  onClick,
}: {
  title: string
  description: string
  selected: boolean
  onClick: () => void
}) => (
  <button
    type="button"
    className={clsx(styles.option, selected && styles.optionSelected)}
    onClick={onClick}
  >
    <span className={styles.optionText}>
      <span className={styles.optionTitle}>{title}</span>
      <span className={styles.optionDescription}>{description}</span>
    </span>
    {selected ? (
      <span className={styles.check} aria-hidden="true">
        <IconCheckOutline16 />
      </span>
    ) : null}
  </button>
)

export const AttachmentModeSheet = ({
  kind,
  attachment,
  format,
  value,
  onSelect,
  onPreview,
  onClose,
}: SheetProps) => {
  const zh = useIsZh()
  useAndroidBackInterception(true)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {onClose()}
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const sliceLongImage = useElsewherePrefs((state) => state.sliceLongImage)
  const customPdfMode = useElsewherePrefs((state) => state.customPdfMode)
  const probe = attachment.probe
  const slices = probe?.estimatedSlices ?? 0
  const pages = probe?.pageCount
  const image = kind === 'image'
  const title = zh ? (image ? '长图发送方式' : 'PDF 发送方式') : image ? 'Long image mode' : 'PDF mode'
  const subtitle = image
    ? probe?.width && probe.height
      ? zh
        ? `${probe.width} × ${probe.height}，仅本次生效`
        : `${probe.width} × ${probe.height}, this attachment only`
      : zh
        ? '仅本次生效'
        : 'This attachment only'
    : pages
      ? zh
        ? `共 ${pages} 页，仅本次生效`
        : `${pages} pages, this attachment only`
      : zh
        ? '仅本次生效'
        : 'This attachment only'

  const imageValue = value ?? (sliceLongImage ? 'slice' : 'original')
  const pdfValue =
    value ??
    (format !== 'chat' && customPdfMode === 'auto' && attachment.size <= NATIVE_PDF_MAX_BYTES
      ? 'pdf_original'
      : 'pdf_text')

  return createPortal(
    <div
      className={styles.overlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {onClose()}
      }}
    >
      <section className={styles.sheet} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.handle} aria-hidden="true" />
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.subtitle}>{subtitle}</p>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </button>
        </header>
        {image ? (
          <>
            <Option
              title={zh ? `自动切分为 ${slices || 'N'} 片` : `Slice into ${slices || 'N'} parts`}
              description={zh ? '保持文字清晰，边缘保留少量重叠' : 'Keeps text sharp with slight edge overlap'}
              selected={imageValue === 'slice'}
              onClick={() => {
                onSelect('slice')
                onClose()
              }}
            />
            <Option
              title={zh ? '按原图发送' : 'Send original image'}
              description={zh ? '作为单张图片发送，文字可能较模糊' : 'Send as one image; small text may be blurry'}
              selected={imageValue === 'original'}
              onClick={() => {
                onSelect('original')
                onClose()
              }}
            />
          </>
        ) : (
          <>
            <Option
              title={zh ? '本地提取文本' : 'Extract text locally'}
              description={zh ? '仅发送文字内容，纯文本模型也能读' : 'Sends text content only'}
              selected={pdfValue === 'pdf_text'}
              onClick={() => {
                onSelect('pdf_text')
                onClose()
              }}
            />
            <Option
              title={
                zh
                  ? `按页转为图片（${pages && pages > 12 ? '前 12 页' : `${pages ?? 'N'} 页`}）`
                  : `Render as images (${pages && pages > 12 ? 'first 12 pages' : `${pages ?? 'N'} pages`})`
              }
              description={zh ? '适合扫描件、手写题与图表较多的页面' : 'Best for scans, handwriting and figure-heavy pages'}
              selected={pdfValue === 'pdf_images'}
              onClick={() => {
                onSelect('pdf_images')
                onClose()
              }}
            />
            {format !== 'chat' ? (
              <Option
                title={zh ? '按原文件发送' : 'Send original file'}
                description={zh ? '需要当前模型接口原生支持 PDF 文件' : 'Requires native PDF support from the current API'}
                selected={pdfValue === 'pdf_original'}
                onClick={() => {
                  onSelect('pdf_original')
                  onClose()
                }}
              />
            ) : null}
          </>
        )}
        {image && onPreview ? (
          <button
            type="button"
            className={styles.previewLink}
            onClick={() => {
              onClose()
              onPreview()
            }}
          >
            {zh ? '预览原图' : 'Preview original'}
          </button>
        ) : null}
      </section>
    </div>,
    document.body
  )
}
