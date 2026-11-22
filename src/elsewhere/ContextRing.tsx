import clsx from 'clsx'
import { memo, useMemo } from 'react'
import { EMPTY_DRAFT, useDrafts } from '../services/chat/drafts.js'
import { useChatStore } from '../services/chat/store.js'
import { useSettings } from '../services/settings.js'
import { computeContextStats } from './contextStats.js'
import { useElsewherePrefs } from './preferences.js'
import { openSessionStatus } from './statusSheetState.js'
import { useIsZh } from './text.js'
import styles from './ContextRing.module.css'

const RING_RADIUS = 6
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS

/** 输入栏轻量上下文占用微圆环，点击弹出「当前对话状态」浮层。 */
export const ContextRing = memo(function ContextRing({ sessionId }: { sessionId: string | null }) {
  const zh = useIsZh()
  const showUsageInChat = useElsewherePrefs((state) => state.showUsageInChat)
  const chatConfig = useSettings((state) => state.chatConfig)
  const session = useChatStore((state) =>
    sessionId !== null && Object.hasOwn(state.sessionCache, sessionId)
      ? state.sessionCache[sessionId]
      : undefined
  )
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)

  const stats = useMemo(
    () => (session ? computeContextStats(session, chatConfig, draft.text) : null),
    [session, chatConfig, draft.text]
  )

  if (!showUsageInChat || !session || !stats?.hasMessages) {
    return null
  }

  const visualRatio = stats.usedTokens > 0 ? Math.max(0.03, stats.ratio) : 0
  const dashOffset = RING_CIRCUMFERENCE * (1 - visualRatio)
  const label = zh
    ? `当前对话上下文占用 ${stats.percent}%，查看详情`
    : `Context usage ${stats.percent}%, view details`

  return (
    <button
      type="button"
      className={clsx(styles.button, stats.isWarning && styles.warning)}
      aria-label={label}
      title={label}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        openSessionStatus(session.id, false)
      }}
    >
      <svg
        className={styles.ring}
        width="16"
        height="16"
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        <circle className={styles.track} cx="8" cy="8" r={RING_RADIUS} />
        <circle
          className={styles.progress}
          cx="8"
          cy="8"
          r={RING_RADIUS}
          strokeDasharray={RING_CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
        />
      </svg>
      <span className={styles.percent}>{stats.percent}%</span>
    </button>
  )
})
