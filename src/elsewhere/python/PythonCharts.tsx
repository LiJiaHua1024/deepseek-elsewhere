import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { IconCloseOutline16 } from '../../components/base/icons.js'
import type { AssistantMessage } from '../../services/chat/types.js'
import { useIsZh } from '../text.js'
import styles from './PythonCharts.module.css'

const collectPythonImages = (message: AssistantMessage): string[] => {
  const images: string[] = []
  for (const block of message.blocks) {
    if (block.type === 'client_tool_call' && block.meta?.kind === 'python' && block.meta.images) {
      for (const src of block.meta.images) {
        if (src) {
          images.push(src)
        }
      }
    }
  }
  return images
}

const PythonImageLightbox = ({
  src,
  index,
  onClose,
}: {
  src: string
  index: number
  onClose: () => void
}) => {
  const zh = useIsZh()

  useAndroidBackInterception(true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  return createPortal(
    <div
      className={styles.lightbox}
      role="dialog"
      aria-modal="true"
      aria-label={zh ? '查看图表' : 'View chart'}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.toolbar}>
        {!android ? (
          <a
            href={src}
            download={`chart-${index + 1}.png`}
            className={styles.actionButton}
          >
            {zh ? '保存图片' : 'Save image'}
          </a>
        ) : null}
        <button
          type="button"
          className={styles.closeButton}
          aria-label={zh ? '关闭' : 'Close'}
          onClick={onClose}
        >
          <IconCloseOutline16 />
        </button>
      </div>
      <img
        src={src}
        alt={zh ? `生成图表 ${index + 1}` : `Generated chart ${index + 1}`}
        className={styles.previewImage}
      />
    </div>,
    document.body
  )
}

export const PythonImageGallery = ({
  images,
  compact = false,
}: {
  images: string[]
  compact?: boolean
}) => {
  const zh = useIsZh()
  const [activeIndex, setActiveIndex] = useState<number | null>(null)

  if (images.length === 0) {
    return null
  }

  const activeSrc = activeIndex !== null ? images[activeIndex] : undefined

  return (
    <>
      <div className={clsx(compact ? styles.galleryCompact : styles.gallery)}>
        {images.map((src, idx) => (
          <button
            key={`${idx}-${src.length}`}
            type="button"
            className={styles.cardButton}
            aria-label={zh ? `放大查看图表 ${idx + 1}` : `Zoom chart ${idx + 1}`}
            onClick={() => setActiveIndex(idx)}
          >
            <img
              src={src}
              alt={zh ? `生成图表 ${idx + 1}` : `Generated chart ${idx + 1}`}
              className={styles.image}
            />
          </button>
        ))}
      </div>
      {activeSrc && activeIndex !== null ? (
        <PythonImageLightbox
          src={activeSrc}
          index={activeIndex}
          onClose={() => setActiveIndex(null)}
        />
      ) : null}
    </>
  )
}

export const PythonCharts = ({ message }: { message: AssistantMessage }) => {
  const images = collectPythonImages(message)
  if (images.length === 0) {
    return null
  }
  return <PythonImageGallery images={images} />
}
