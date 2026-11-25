import clsx from 'clsx'
import { memo, useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useUploads, type UploadTask } from '../../services/attachments.js'
import {
  setDraftAttachmentMode,
  setDraftAttachmentProbe,
  setEditAttachmentMode,
  setEditAttachmentProbe,
  useDrafts,
  type DraftAttachment,
} from '../../services/chat/drafts.js'
import type { CustomAttachmentMode } from '../../services/chat/types.js'
import { IconCloseFill14, IconPhotoErrorFill20, IconRefreshOutline16 } from '../base/icons.js'
import { Tooltip } from '../base/Tooltip.js'
import { FileCard } from '../files/FileCard.js'
import styles from './ChatInput.module.css'
import { AttachmentModeSheet } from '../../elsewhere/attachments/AttachmentModeSheet.js'
import { probeAttachment } from '../../elsewhere/attachments/probe.js'
import { useElsewherePrefs } from '../../elsewhere/preferences.js'
import { useIsZh } from '../../elsewhere/text.js'
import { useSettings } from '../../services/settings.js'

const UPLOADING: UploadTask = { status: 'uploading' }
const isPdfName = (name: string) => name.toLowerCase().endsWith('.pdf')

type DraftOwner = { type: 'draft'; sessionId: string | null } | { type: 'edit' } | null

const findDraftOwner = (attachmentId: string): DraftOwner => {
  const state = useDrafts.getState()
  if (state.editing?.attachments.some((item) => item.id === attachmentId)) {return { type: 'edit' }}
  for (const [sessionId, draft] of state.drafts) {
    if (draft.attachments.some((item) => item.id === attachmentId)) {
      return { type: 'draft', sessionId }
    }
  }
  return null
}

/** 列表只随草稿附件变化更新；每张卡片独立订阅自己的上传状态。 */
export const DraftAttachments = memo(function DraftAttachments({
  items,
  onRetry,
  onRemove,
  onPreview,
  exiting = false,
  localOnly = false,
}: {
  items: DraftAttachment[]
  onRetry: (id: string) => void
  onRemove: (id: string) => void
  onPreview?: (id: string) => void
  exiting?: boolean
  localOnly?: boolean
}) {
  const format = useSettings((state) => state.chatConfig.format)
  const [modeTargetId, setModeTargetId] = useState<string>()
  const modeTarget = items.find((item) => item.id === modeTargetId)
  if (items.length === 0) {
    return null
  }
  const selectMode = (mode?: CustomAttachmentMode) => {
    if (!modeTarget) {return}
    const owner = findDraftOwner(modeTarget.id)
    if (owner?.type === 'edit') {
      setEditAttachmentMode(modeTarget.id, mode)
    } else if (owner?.type === 'draft') {
      setDraftAttachmentMode(owner.sessionId, modeTarget.id, mode)
    }
  }
  return (
    <div className={styles.attachments}>
      {items.map((item) => (
        <AttachmentItem
          key={item.id}
          item={item}
          ready={exiting || localOnly}
          localOnly={localOnly}
          onRetry={() => onRetry(item.id)}
          onRemove={() => onRemove(item.id)}
          onPreview={!exiting && onPreview ? () => onPreview(item.id) : undefined}
          onOpenMode={localOnly && !exiting ? () => setModeTargetId(item.id) : undefined}
        />
      ))}
      {modeTarget && localOnly ? (
        <AttachmentModeSheet
          kind={modeTarget.isImage ? 'image' : 'pdf'}
          attachment={modeTarget}
          format={format}
          value={modeTarget.customMode}
          onSelect={selectMode}
          onPreview={modeTarget.isImage && onPreview ? () => onPreview(modeTarget.id) : undefined}
          onClose={() => setModeTargetId(undefined)}
        />
      ) : null}
    </div>
  )
})

/** 输入框里的文件：图片显示缩略图，其余显示文件卡片 */
const AttachmentItem = ({
  item,
  ready,
  localOnly,
  onRetry,
  onRemove,
  onPreview,
  onOpenMode,
}: {
  item: DraftAttachment
  ready: boolean
  localOnly: boolean
  onRetry: () => void
  onRemove: () => void
  onPreview?: () => void
  onOpenMode?: () => void
}) => {
  const t = useTranslate()
  const zh = useIsZh()
  const task = useUploads((state) => state.tasks[item.id] ?? UPLOADING)
  const sliceLongImage = useElsewherePrefs((state) => state.sliceLongImage)
  const customPdfMode = useElsewherePrefs((state) => state.customPdfMode)
  const format = useSettings((state) => state.chatConfig.format)
  const status = ready || item.existing ? 'done' : task.status

  useEffect(() => {
    if (!localOnly || item.probe || (!item.isImage && !isPdfName(item.name))) {return}
    let cancelled = false
    void probeAttachment(item).then((probe) => {
      if (!cancelled && probe) {
        const owner = findDraftOwner(item.id)
        if (owner?.type === 'edit') {
          setEditAttachmentProbe(item.id, probe)
        } else if (owner?.type === 'draft') {
          setDraftAttachmentProbe(owner.sessionId, item.id, probe)
        }
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [item, localOnly])

  const error =
    status === 'error' && task.status === 'error' ? t(task.error.key, task.error.params) : undefined
  const retry =
    status === 'error' && task.status === 'error' && task.retryable ? onRetry : undefined
  const failed = status === 'error'
  const retryLabel = t('uploadRetry', { message: error ?? t('uploadFileStatusFailed') })
  const showReason = failed && error !== undefined && error !== t('uploadFileStatusFailed')
  const longImage = item.isImage && localOnly && Boolean(item.probe?.estimatedSlices)
  const slicing = item.customMode === 'slice' || (item.customMode !== 'original' && sliceLongImage)
  const openImage = longImage && onOpenMode ? onOpenMode : onPreview

  if (item.isImage) {
    return (
      <div
        className={clsx(
          styles.attachment,
          failed && styles.attachmentFailed,
          longImage && slicing && styles.attachmentSlicing
        )}
        title={error ?? item.name}
      >
        {item.previewUrl ? (
          openImage ? (
            <button
              type="button"
              className={styles.previewImage}
              aria-label={t('androidPreviewDraftImage', { name: item.name })}
              onClick={openImage}
            >
              <img src={item.previewUrl} alt="" />
            </button>
          ) : (
            <img src={item.previewUrl} alt={item.name} />
          )
        ) : item.blob === null ? (
          <span className={styles.missingImage} role="img" aria-label={item.name}>
            <IconPhotoErrorFill20 />
          </span>
        ) : null}
        {longImage ? (
          <span className={styles.sliceBadge}>
            {slicing
              ? zh
                ? `切 ${item.probe?.estimatedSlices ?? 0} 片`
                : `${item.probe?.estimatedSlices ?? 0} slices`
              : zh
                ? '原图'
                : 'Original'}
          </span>
        ) : null}
        {status === 'uploading' ? <div className={styles.uploading} /> : null}
        {failed && retry ? (
          <Tooltip content={retryLabel}>
            <button type="button" className={styles.failed} aria-label={retryLabel} onClick={retry}>
              <IconRefreshOutline16 />
              {showReason ? <span className={styles.failedReason}>{error}</span> : null}
            </button>
          </Tooltip>
        ) : null}
        {failed && !retry ? (
          <div className={clsx(styles.failed, styles.failedStatic)} aria-label={error}>
            {showReason ? <span className={styles.failedReason}>{error}</span> : null}
          </div>
        ) : null}
        <button
          type="button"
          className={clsx(styles.remove, failed && !retry && styles.invalidRemove)}
          aria-label={t('delete')}
          onClick={onRemove}
        >
          <IconCloseFill14 />
        </button>
      </div>
    )
  }

  const pdf = localOnly && isPdfName(item.name)
  const effectivePdfMode =
    item.customMode ??
    (format !== 'chat' && customPdfMode === 'auto' && item.size <= 10 * 1024 * 1024
      ? 'pdf_original'
      : 'pdf_text')
  const pdfLabel = pdf
    ? effectivePdfMode === 'pdf_original'
      ? zh
        ? '按原件'
        : 'Original'
      : effectivePdfMode === 'pdf_images'
        ? zh
          ? `转 ${Math.min(item.probe?.pageCount ?? 12, 12)} 页图`
          : `${Math.min(item.probe?.pageCount ?? 12, 12)} pages`
        : zh
          ? '提取文本'
          : 'Text'
    : undefined

  return (
    <FileCard
      name={item.name}
      size={item.size}
      status={status}
      error={error}
      statusLabel={pdfLabel}
      onRetry={retry}
      onRemove={onRemove}
      onOpen={pdf ? onOpenMode : undefined}
    />
  )
}
