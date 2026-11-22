import clsx from 'clsx'
import { IconBrowseOutline16, IconSearchOutline16 } from '../../components/base/icons.js'
import { getSiteName, type ClientToolStep } from '../../services/chat/view.js'
import { useIsZh } from '../text.js'
import { openToolDetail } from './toolDetailState.js'
import styles from './ClientToolTimelineRow.module.css'

const getFetchDisplayLabel = (step: ClientToolStep): string => {
  const { block } = step
  if (block.meta?.kind === 'fetch') {
    return block.meta.title || getSiteName(block.meta.url) || block.meta.url
  }
  const url = typeof block.input.url === 'string' ? block.input.url : ''
  return getSiteName(url) || url
}

export const ClientToolTimelineRow = ({
  step,
  isLast,
}: {
  step: ClientToolStep
  isLast: boolean
}) => {
  const zh = useIsZh()
  const { block } = step
  const running = block.status === 'running'
  const failed = block.status === 'error'

  if (block.status === 'aborted_loop') {
    return (
      <div className={clsx(styles.item, !isLast && styles.withLine)}>
        <span className={styles.dot}>
          <span className={styles.dotInner} />
        </span>
        <div className={styles.staticRow}>
          {zh ? '已停止重复调用' : 'Stopped repeated calls'}
        </div>
      </div>
    )
  }

  let title: string
  let suffix = ''
  let suffixError = false
  let icon = <IconSearchOutline16 />
  let queryLabels: string[] = []
  let fetchLabel = ''

  if (block.name === 'web_search') {
    title = zh ? '搜索网页' : 'Web search'
    icon = <IconSearchOutline16 />
    if (block.meta?.kind === 'search') {
      queryLabels = block.meta.queries
      const count = block.meta.results.length
      if (block.status === 'done') {
        suffix = zh ? ` · ${count} 条结果` : ` · ${count} ${count === 1 ? 'result' : 'results'}`
      }
    } else if (typeof block.input.query === 'string' && block.input.query.trim()) {
      queryLabels = [block.input.query.trim()]
    }
    if (failed) {
      suffix = zh ? ' · 搜索失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    }
  } else if (block.name === 'web_fetch') {
    title = zh ? '读取网页' : 'Read page'
    icon = <IconBrowseOutline16 />
    fetchLabel = getFetchDisplayLabel(step)
    if (failed) {
      suffix = zh ? ' · 读取失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    } else if (block.meta?.kind === 'fetch' && block.meta.truncated) {
      suffix = zh ? ' · 已截断' : ' · Truncated'
    }
  } else {
    title = block.name
    icon = <IconBrowseOutline16 />
    if (failed) {
      suffix = zh ? ' · 失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    } else if (block.meta?.kind === 'generic' && block.meta.summary) {
      suffix = ` · ${block.meta.summary}`
    }
  }

  return (
    <div className={clsx(styles.item, !isLast && styles.withLine)}>
      <span className={styles.dot}>
        <span
          className={clsx(
            styles.dotInner,
            running && styles.dotRunning,
            failed && styles.dotError
          )}
        />
      </span>
      <button type="button" className={styles.trigger} onClick={() => openToolDetail(block)}>
        <span className={styles.actionLine}>
          <span className={styles.actionIcon}>{icon}</span>
          <span className={styles.actionText}>
            {title}
            {suffix ? (
              <span className={suffixError ? styles.metaError : styles.metaMuted}>{suffix}</span>
            ) : null}
          </span>
        </span>
        {queryLabels.length > 0 ? (
          <span className={styles.chips}>
            {queryLabels.map((query, idx) => (
              <span key={`${idx}-${query}`} className={styles.chip}>
                <span className={styles.chipText}>{query}</span>
              </span>
            ))}
          </span>
        ) : null}
        {fetchLabel ? <span className={styles.pageTag}>{fetchLabel}</span> : null}
      </button>
    </div>
  )
}
