import { memo } from 'react'
import { useElsewherePrefs } from './preferences.js'
import { openSessionStatus } from './statusSheetState.js'
import { useIsZh } from './text.js'
import styles from './SummaryDivider.module.css'

/** 已触发自动摘要时，在消息流对应位置展示轻分割提示，点击可查看摘要详情。 */
export const SummaryDivider = memo(function SummaryDivider({
  sessionId,
  summarizedRounds,
}: {
  sessionId: string
  summarizedRounds: number
}) {
  const zh = useIsZh()
  const showUsageInChat = useElsewherePrefs((state) => state.showUsageInChat)

  if (!showUsageInChat || summarizedRounds <= 0) {
    return null
  }

  const label = zh
    ? `已自动摘要较早 ${summarizedRounds} 轮 · 查看`
    : `Summarized ${summarizedRounds} earlier ${summarizedRounds === 1 ? 'turn' : 'turns'} · View`

  return (
    <div className={styles.divider}>
      <span className={styles.line} aria-hidden="true" />
      <button
        type="button"
        className={styles.pill}
        onClick={() => openSessionStatus(sessionId, true)}
      >
        {label}
      </button>
      <span className={styles.line} aria-hidden="true" />
    </div>
  )
})
