import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { android } from '../app/android.js'
import { useAndroidBackInterception } from '../app/useAndroidBackInterception.js'
import { useIsMobile } from '../app/viewport.js'
import {
  IconChevronDownOutline14,
  IconCloseOutline16,
} from '../components/base/icons.js'
import { CHAT_API_FORMATS } from '../services/api/chatConfig.js'
import { getVisibleMessages } from '../services/chat/branches.js'
import { EMPTY_DRAFT, useDrafts } from '../services/chat/drafts.js'
import { useChatStore } from '../services/chat/store.js'
import { useSettings } from '../services/settings.js'
import {
  formatBalanceCompact,
  getPrimaryCurrency,
  isLowBalance,
  refreshBalance,
  useBalanceStore,
} from './balanceStore.js'
import { computeContextStats, formatTokenCount } from './contextStats.js'
import { estimateSessionCost, formatCurrency } from './pricing.js'
import { closeSessionStatus, useStatusSheet } from './statusSheetState.js'
import { externalLinkProps, useIsZh } from './text.js'
import styles from './SessionStatusSheet.module.css'

/** 当前对话状态底部浮层（移动端 Bottom Sheet / 桌面端轻量弹层）。 */
export const SessionStatusSheet = () => {
  const open = useStatusSheet((state) => state.open)
  const sessionId = useStatusSheet((state) => state.sessionId)
  const activeId = useChatStore((state) => state.activeId)

  useEffect(() => {
    if (open && sessionId !== activeId) {
      closeSessionStatus()
    }
  }, [activeId, open, sessionId])

  if (!open || !sessionId) {
    return null
  }

  return <SessionStatusContent sessionId={sessionId} />
}

const SessionStatusContent = ({ sessionId }: { sessionId: string }) => {
  const zh = useIsZh()
  const isMobile = useIsMobile()
  const bottomSheet = isMobile || Boolean(android)
  const locale = useSettings((state) => state.locale)
  const chatConfig = useSettings((state) => state.chatConfig)
  const apiKey = useSettings((state) => state.apiKey)
  const session = useChatStore((state) =>
    Object.hasOwn(state.sessionCache, sessionId) ? state.sessionCache[sessionId] : undefined
  )
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const balanceSnapshot = useBalanceStore((state) => state.snapshot)
  const expandSummaryDefault = useStatusSheet((state) => state.expandSummary)
  const [summaryOpen, setSummaryOpen] = useState(expandSummaryDefault)

  useAndroidBackInterception(true)

  useEffect(() => {
    setSummaryOpen(expandSummaryDefault)
  }, [expandSummaryDefault, sessionId])

  useEffect(() => {
    if (apiKey) {
      void refreshBalance()
    }
  }, [apiKey])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeSessionStatus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!session) {
    return null
  }

  const visibleMessages = getVisibleMessages(session)
  const stats = computeContextStats(session, chatConfig, draft.text)
  const customEndpoint = Boolean(chatConfig.endpoint)
  const primaryCurrency = getPrimaryCurrency(balanceSnapshot, locale)
  const cost = estimateSessionCost(visibleMessages, primaryCurrency, customEndpoint)

  const summaryPercent =
    stats.windowTokens > 0
      ? Math.min(100, (stats.summaryTokens / stats.windowTokens) * 100)
      : 0
  const recentPercent =
    stats.windowTokens > 0
      ? Math.min(100 - summaryPercent, (stats.recentTokens / stats.windowTokens) * 100)
      : 0
  const totalPercentBar = Math.min(100, stats.ratio * 100)

  const sourceLabel = customEndpoint
    ? zh
      ? `自定义端点 · ${CHAT_API_FORMATS[chatConfig.format]}`
      : `Custom endpoint · ${CHAT_API_FORMATS[chatConfig.format]}`
    : zh
      ? 'DeepSeek 官方'
      : 'DeepSeek Official'

  const lowBalance = isLowBalance(balanceSnapshot)
  const balanceText = balanceSnapshot ? formatBalanceCompact(balanceSnapshot) : null

  const renderStatusLine = () => {
    if (stats.checkpoint) {
      const base = zh
        ? `已自动摘要较早 ${stats.checkpoint.summarizedRounds} 轮，保留最近 ${stats.checkpoint.recentRounds} 轮原文`
        : `Summarized ${stats.checkpoint.summarizedRounds} earlier ${stats.checkpoint.summarizedRounds === 1 ? 'turn' : 'turns'}, keeping ${stats.checkpoint.recentRounds} recent ${stats.checkpoint.recentRounds === 1 ? 'turn' : 'turns'}`
      if (stats.isWarning) {
        return (
          <p className={clsx(styles.statusHint, styles.warningText)}>
            {base}
            {zh ? ' · 接近上限，继续发送将再次摘要' : ' · Near limit, will summarize again'}
          </p>
        )
      }
      return <p className={styles.statusHint}>{base}</p>
    }
    if (stats.isWarning) {
      return (
        <p className={clsx(styles.statusHint, styles.warningText)}>
          {zh
            ? '接近上下文上限，继续发送将自动摘要较早轮次'
            : 'Approaching context limit; earlier turns will be summarized automatically'}
        </p>
      )
    }
    return (
      <p className={styles.statusHint}>
        {zh ? '上下文充裕，可继续正常对话' : 'Plenty of context space remaining'}
      </p>
    )
  }

  const formatCostValue = () => {
    if (!cost) {
      return ''
    }
    const total = formatCurrency(cost.totalCost, cost.currency)
    if (cost.cacheSaved >= 0.005) {
      const saved = formatCurrency(cost.cacheSaved, cost.currency)
      return zh ? `${total}（缓存省 ${saved}）` : `${total} (saved ${saved})`
    }
    return total
  }

  return createPortal(
    <div
      className={clsx(styles.overlay, bottomSheet && styles.sheetOverlay)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeSessionStatus()
        }
      }}
    >
      <section
        className={clsx(styles.panel, bottomSheet && styles.sheet)}
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '当前对话状态' : 'Current conversation status'}
      >
        {bottomSheet ? <div className={styles.handle} aria-hidden="true" /> : null}
        <header className={styles.header}>
          <h2 className={styles.title}>{zh ? '当前对话状态' : 'Conversation Status'}</h2>
          <div className={styles.headerRight}>
            <span className={styles.modelPill}>{stats.modelName}</span>
            {!bottomSheet ? (
              <button
                type="button"
                className={styles.closeButton}
                aria-label={zh ? '关闭' : 'Close'}
                onClick={closeSessionStatus}
              >
                <IconCloseOutline16 />
              </button>
            ) : null}
          </div>
        </header>

        <div className={styles.contextCard}>
          <div className={styles.usageHead}>
            <span className={clsx(styles.percentValue, stats.isWarning && styles.warningText)}>
              {stats.percent}%
            </span>
            <span className={styles.tokenRatio}>
              {formatTokenCount(stats.usedTokens)} / {formatTokenCount(stats.windowTokens)}
            </span>
          </div>

          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={stats.percent}
          >
            {stats.checkpoint ? (
              <>
                <span
                  className={styles.segmentSummary}
                  style={{
                    width: `${stats.summaryTokens > 0 ? Math.max(2, summaryPercent) : 0}%`,
                  }}
                />
                <span
                  className={clsx(
                    styles.segmentRecent,
                    stats.isWarning && styles.segmentWarning
                  )}
                  style={{
                    width: `${stats.recentTokens > 0 ? Math.max(2, recentPercent) : 0}%`,
                  }}
                />
              </>
            ) : (
              <span
                className={clsx(styles.segmentSingle, stats.isWarning && styles.segmentWarning)}
                style={{
                  width: `${stats.usedTokens > 0 ? Math.max(2, totalPercentBar) : 0}%`,
                }}
              />
            )}
          </div>

          {stats.checkpoint ? (
            <div className={styles.legend}>
              <span className={styles.legendItem}>
                <i className={styles.dotSummary} />
                {zh
                  ? `早期摘要 ${formatTokenCount(stats.summaryTokens)}`
                  : `Summary ${formatTokenCount(stats.summaryTokens)}`}
              </span>
              <span className={styles.legendItem}>
                <i className={clsx(styles.dotRecent, stats.isWarning && styles.dotWarning)} />
                {zh
                  ? `近期原文 ${formatTokenCount(stats.recentTokens)}`
                  : `Recent ${formatTokenCount(stats.recentTokens)}`}
              </span>
            </div>
          ) : null}

          {renderStatusLine()}

          {stats.checkpoint ? (
            <div className={styles.summarySection}>
              <button
                type="button"
                className={styles.summaryToggle}
                aria-expanded={summaryOpen}
                onClick={() => setSummaryOpen((prev) => !prev)}
              >
                <span>{zh ? '查看早期摘要' : 'View earlier summary'}</span>
                <span className={clsx(styles.chevron, summaryOpen && styles.chevronOpen)}>
                  <IconChevronDownOutline14 />
                </span>
              </button>
              {summaryOpen ? (
                <pre className={styles.summaryBody}>{stats.checkpoint.summary}</pre>
              ) : null}
            </div>
          ) : null}
        </div>

        <dl className={styles.metaList}>
          <div className={styles.metaRow}>
            <dt>{zh ? '服务来源' : 'Provider'}</dt>
            <dd>{sourceLabel}</dd>
          </div>
          {cost ? (
            <div className={styles.metaRow}>
              <dt>{zh ? '本会话估算花费' : 'Estimated cost'}</dt>
              <dd className={styles.tabular}>{formatCostValue()}</dd>
            </div>
          ) : null}
          {apiKey && balanceText ? (
            <div className={styles.metaRow}>
              <dt>{zh ? '官方账户余额' : 'Official balance'}</dt>
              <dd className={clsx(styles.tabular, lowBalance && styles.warningText)}>
                {!balanceSnapshot?.isAvailable
                  ? `${balanceText} · ${zh ? '不可用' : 'Unavailable'}`
                  : lowBalance
                    ? `${balanceText} · ${zh ? '偏低' : 'Low'}`
                    : balanceText}
                {lowBalance ? (
                  <a className={styles.inlineTopUp} {...externalLinkProps()}>
                    {zh ? '充值' : 'Top up'}
                  </a>
                ) : null}
              </dd>
            </div>
          ) : null}
        </dl>
      </section>
    </div>,
    document.body
  )
}
