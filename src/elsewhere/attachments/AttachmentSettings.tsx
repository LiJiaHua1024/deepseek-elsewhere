import clsx from 'clsx'
import { setCustomPdfMode, setSliceLongImage, useElsewherePrefs } from '../preferences.js'
import { useIsZh } from '../text.js'
import styles from './AttachmentSettings.module.css'

export const AttachmentSettings = ({ cards = false }: { cards?: boolean }) => {
  const zh = useIsZh()
  const sliceLongImage = useElsewherePrefs((state) => state.sliceLongImage)
  const customPdfMode = useElsewherePrefs((state) => state.customPdfMode)
  const sliceLabel = zh ? '长图自动切分' : 'Slice long images'
  const pdfLabel = zh ? '第三方接口 PDF 处理' : 'PDF handling for custom APIs'
  return (
    <div className={clsx(styles.group, cards && styles.cards)}>
      <div className={styles.card}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>{sliceLabel}</div>
            <div className={styles.description}>
              {zh
                ? '第三方接口发送超长截图时自动切片，避免文字模糊'
                : 'Slice very long screenshots for custom APIs to keep text sharp'}
            </div>
          </div>
          <button
            type="button"
            className={styles.switch}
            role="switch"
            aria-label={sliceLabel}
            aria-checked={sliceLongImage}
            onClick={() => setSliceLongImage(!sliceLongImage)}
          >
            <span />
          </button>
        </div>
      </div>
      <div className={styles.card}>
        <div className={styles.row}>
          <div className={styles.text}>
            <div className={styles.label}>{pdfLabel}</div>
            <div className={styles.description}>
              {customPdfMode === 'auto'
                ? zh
                  ? '优先按接口支持情况处理，不支持或文件过大时自动在本地提取'
                  : 'Use native PDF when supported; extract locally when unsupported or too large'
                : zh
                  ? '统一在本地提取文本，扫描页自动转为图片发送'
                  : 'Always extract text locally and render scanned pages as images'}
            </div>
          </div>
          <div className={styles.segmented} role="radiogroup" aria-label={pdfLabel}>
            <button
              type="button"
              role="radio"
              aria-checked={customPdfMode === 'auto'}
              className={clsx(styles.segment, customPdfMode === 'auto' && styles.segmentActive)}
              onClick={() => setCustomPdfMode('auto')}
            >
              {zh ? '自动' : 'Auto'}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={customPdfMode === 'local'}
              className={clsx(styles.segment, customPdfMode === 'local' && styles.segmentActive)}
              onClick={() => setCustomPdfMode('local')}
            >
              {zh ? '始终本地提取' : 'Always local'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
