import clsx from 'clsx'
import { memo, useEffect } from 'react'
import { useSettings } from '../services/settings.js'
import {
  formatBalanceCompact,
  isLowBalance,
  refreshBalance,
  useBalanceStore,
} from './balanceStore.js'
import { useIsZh } from './text.js'
import styles from './SiderBalance.module.css'

/** 侧边栏底部账号名下方的轻量余额行；无官方 Key 或尚未查到余额时隐藏。 */
export const SiderBalance = memo(function SiderBalance({ active }: { active: boolean }) {
  const zh = useIsZh()
  const apiKey = useSettings((state) => state.apiKey)
  const snapshot = useBalanceStore((state) => state.snapshot)

  useEffect(() => {
    if (active && apiKey) {
      void refreshBalance()
    }
  }, [active, apiKey])

  if (!apiKey || !snapshot) {
    return null
  }

  const low = isLowBalance(snapshot)
  const compact = formatBalanceCompact(snapshot)
  if (!compact) {
    return null
  }

  const label = !snapshot.isAvailable
    ? zh
      ? `余额 ${compact} · 不足`
      : `Balance ${compact} · Low`
    : low
      ? zh
        ? `余额 ${compact} · 偏低`
        : `Balance ${compact} · Low`
      : zh
        ? `余额 ${compact}`
        : `Balance ${compact}`

  return <span className={clsx(styles.balance, low && styles.low)}>{label}</span>
})
