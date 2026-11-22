import { memo, useState } from 'react'
import { IconCloseOutline16, IconWarningOutline16 } from '../components/base/icons.js'
import { useSettings } from '../services/settings.js'
import {
  formatBalanceCompact,
  isLowBalance,
  useBalanceStore,
} from './balanceStore.js'
import { externalLinkProps, useIsZh } from './text.js'
import styles from './LowBalanceBanner.module.css'

/** 当前会话内手动关闭过低余额提示的集合（新建对话用 'new'）。 */
const dismissedSessions = new Set<string>()

/** 官方渠道余额不足或偏低时，在输入框上方展示可手动关闭的温和提醒条。 */
export const LowBalanceBanner = memo(function LowBalanceBanner({
  sessionId,
}: {
  sessionId: string | null
}) {
  const zh = useIsZh()
  const apiKey = useSettings((state) => state.apiKey)
  const customEndpoint = useSettings((state) => Boolean(state.chatConfig.endpoint))
  const snapshot = useBalanceStore((state) => state.snapshot)
  const scopeKey = sessionId ?? 'new'
  const [, setDismissTick] = useState(0)

  if (customEndpoint || !apiKey || !snapshot || !isLowBalance(snapshot)) {
    return null
  }
  if (dismissedSessions.has(scopeKey)) {
    return null
  }

  const compactBalance = formatBalanceCompact(snapshot)
  const message = !snapshot.isAvailable
    ? zh
      ? 'DeepSeek 官方账户余额不足，可能无法继续对话'
      : 'DeepSeek official balance is unavailable; requests may fail'
    : zh
      ? `DeepSeek 官方账户余额偏低（${compactBalance}）`
      : `DeepSeek official balance is low (${compactBalance})`

  return (
    <div className={styles.banner} role="status">
      <span className={styles.icon} aria-hidden="true">
        <IconWarningOutline16 />
      </span>
      <span className={styles.message}>{message}</span>
      <a className={styles.topUp} {...externalLinkProps()}>
        {zh ? '充值' : 'Top up'}
      </a>
      <button
        type="button"
        className={styles.close}
        aria-label={zh ? '关闭余额提醒' : 'Dismiss balance notice'}
        onClick={() => {
          dismissedSessions.add(scopeKey)
          setDismissTick((tick) => tick + 1)
        }}
      >
        <IconCloseOutline16 />
      </button>
    </div>
  )
})
