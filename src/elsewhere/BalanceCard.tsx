import clsx from 'clsx'
import { memo, useEffect } from 'react'
import {
  IconRefreshOutline16,
  IconRightUpOutline14,
} from '../components/base/icons.js'
import { useSettings } from '../services/settings.js'
import {
  formatBalanceValue,
  getDisplayBalances,
  isLowBalance,
  refreshBalance,
  useBalanceStore,
} from './balanceStore.js'
import { externalLinkProps, formatUpdatedTime, useIsZh } from './text.js'
import styles from './BalanceCard.module.css'

/** 设置页 -> 账号与接口页的官方余额卡片；纯自定义端点无官方 Key 时隐藏。 */
export const BalanceCard = memo(function BalanceCard({
  variant,
}: {
  variant: 'android' | 'web'
}) {
  const zh = useIsZh()
  const locale = useSettings((state) => state.locale)
  const apiKey = useSettings((state) => state.apiKey)
  const snapshot = useBalanceStore((state) => state.snapshot)
  const loading = useBalanceStore((state) => state.loading)

  useEffect(() => {
    if (apiKey) {
      void refreshBalance()
    }
  }, [apiKey])

  if (!apiKey) {
    return null
  }

  const items = snapshot ? getDisplayBalances(snapshot.balanceInfos) : []
  const low = isLowBalance(snapshot)

  return (
    <section
      className={clsx(styles.card, variant === 'android' ? styles.android : styles.web)}
      aria-label={zh ? '官方账户余额' : 'Official account balance'}
    >
      <div className={styles.top}>
        <div className={styles.titleRow}>
          <span className={styles.title}>{zh ? '官方账户余额' : 'Official balance'}</span>
          {low && snapshot ? (
            <span className={styles.badge}>
              {!snapshot.isAvailable
                ? zh
                  ? '不可用'
                  : 'Unavailable'
                : zh
                  ? '偏低'
                  : 'Low'}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          className={clsx(styles.refresh, loading && styles.spinning)}
          aria-label={zh ? '刷新余额' : 'Refresh balance'}
          disabled={loading}
          onClick={() => void refreshBalance({ force: true })}
        >
          <IconRefreshOutline16 />
        </button>
      </div>

      {items.length > 0 ? (
        <div className={styles.amounts}>
          {items.map((item) => (
            <div key={item.currency} className={styles.amountItem}>
              <div className={clsx(styles.total, low && styles.lowAmount)}>
                {formatBalanceValue(item.total_balance, item.currency)}
              </div>
              <div className={styles.breakdown}>
                {zh
                  ? `充值 ${formatBalanceValue(item.topped_up_balance, item.currency)} · 赠金 ${formatBalanceValue(item.granted_balance, item.currency)}`
                  : `Topped up ${formatBalanceValue(item.topped_up_balance, item.currency)} · Granted ${formatBalanceValue(item.granted_balance, item.currency)}`}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={styles.placeholder}>
          {loading
            ? zh
              ? '正在查询余额…'
              : 'Checking balance…'
            : zh
              ? '暂未获取到余额，可点击右上角刷新'
              : 'Balance unavailable; tap refresh to retry'}
        </div>
      )}

      <div className={styles.footer}>
        <span className={styles.updated}>
          {snapshot ? formatUpdatedTime(snapshot.updatedAt, locale) : ''}
        </span>
        <a className={styles.topUp} {...externalLinkProps()}>
          <span>{zh ? '前往充值' : 'Top up'}</span>
          <IconRightUpOutline14 />
        </a>
      </div>
    </section>
  )
})
