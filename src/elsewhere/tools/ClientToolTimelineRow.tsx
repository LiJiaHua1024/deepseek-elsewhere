import clsx from 'clsx'
import { IconBrowseOutline16, IconSearchOutline16 } from '../../components/base/icons.js'
import { getSiteName, type ClientToolStep } from '../../services/chat/view.js'
import { useIsZh } from '../text.js'
import { openToolDetail } from './toolDetailState.js'
import styles from './ClientToolTimelineRow.module.css'

const IconCodeOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M5.5 4.25L1.75 8L5.5 11.75M10.5 4.25L14.25 8L10.5 11.75M8.9 3.1L7.1 12.9"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IconBookOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M3 12.8A1.8 1.8 0 0 1 4.8 11h8.2M4.8 2h8.2v12H4.8A1.8 1.8 0 0 1 3 12.2V3.8A1.8 1.8 0 0 1 4.8 2Z"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

const IconToolOutline16 = () => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path
      d="M9.9 2.4a3.4 3.4 0 0 0-3.2 4.55L2.45 11.2a1.25 1.25 0 0 0 1.77 1.77l4.25-4.25a3.4 3.4 0 0 0 4.55-3.2 3.3 3.3 0 0 0-.32-1.42l-1.92 1.92-1.4-1.4 1.92-1.92A3.3 3.3 0 0 0 9.9 2.4Z"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
)

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
  const running = block.status === 'running' || block.status === 'awaiting_confirmation'
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
  } else if (block.name === 'run_python') {
    title = zh ? '运行 Python' : 'Run Python'
    icon = <IconCodeOutline16 />
    if (failed) {
      suffix = zh ? ' · 运行失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    } else if (block.meta?.kind === 'python') {
      const parts: string[] = []
      if (block.meta.images && block.meta.images.length > 0) {
        const count = block.meta.images.length
        parts.push(zh ? `已生成 ${count} 张图` : `${count} ${count === 1 ? 'chart' : 'charts'}`)
      }
      if (block.meta.truncated) {
        parts.push(zh ? '已截断' : 'Truncated')
      }
      if (parts.length > 0) {
        suffix = ` · ${parts.join(' · ')}`
      }
    }
  } else if (block.name === 'search_history') {
    title = zh ? '搜索历史对话' : 'Search history'
    icon = <IconSearchOutline16 />
    if (block.meta?.kind === 'history') {
      if (block.meta.query) {
        queryLabels = [block.meta.query]
      }
      if (block.status === 'done') {
        suffix = zh
          ? ` · ${block.meta.count} 条结果`
          : ` · ${block.meta.count} ${block.meta.count === 1 ? 'result' : 'results'}`
        if (block.meta.truncated) {
          suffix += zh ? ' · 已截断' : ' · Truncated'
        }
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
  } else if (
    block.name === 'memory_read' ||
    block.name === 'memory_search' ||
    block.name === 'memory_write'
  ) {
    const memoryMeta = block.meta?.kind === 'memory' ? block.meta : undefined
    const rawPath =
      memoryMeta?.path ?? (typeof block.input.path === 'string' ? block.input.path : '')
    const noteLabel = rawPath.replace(/.md$/i, '').split('/').at(-1) ?? rawPath
    icon = <IconBookOutline16 />
    if (block.name === 'memory_read') {
      title = (zh ? '读取记忆' : 'Read memory') + (noteLabel ? ' · ' + noteLabel : '')
    } else if (block.name === 'memory_write') {
      title = (zh ? '更新记忆' : 'Update memory') + (noteLabel ? ' · ' + noteLabel : '')
    } else {
      title = zh ? '检索记忆' : 'Search memory'
      const query = memoryMeta?.query ?? (typeof block.input.query === 'string' ? block.input.query : '')
      if (query.trim()) {
        queryLabels = [query.trim()]
      }
      if (block.status === 'done' && memoryMeta?.resultCount !== undefined) {
        const count = memoryMeta.resultCount
        suffix = zh ? ' · ' + count + ' 条结果' : ' · ' + count + (count === 1 ? ' result' : ' results')
      }
    }
    if (failed) {
      suffix = zh ? ' · 失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    } else if (block.status === 'awaiting_confirmation') {
      suffix = zh ? ' · 等待确认' : ' · Awaiting confirmation'
    }
  } else {
    const toolLabel = block.displayName ?? block.name
    title = block.serverName ? `${block.serverName} · ${toolLabel}` : toolLabel
    icon = <IconToolOutline16 />
    if (block.status === 'awaiting_confirmation') {
      suffix = zh ? ' · 等待确认' : ' · Awaiting confirmation'
    } else if (block.status === 'denied') {
      suffix = zh ? ' · 已拒绝' : ' · Denied'
    } else if (failed) {
      suffix = zh ? ' · 失败' : ' · Failed'
      suffixError = true
    } else if (block.status === 'stopped') {
      suffix = zh ? ' · 已停止' : ' · Stopped'
    } else if (block.meta?.kind === 'generic') {
      const parts: string[] = []
      if (block.meta.summary) {
        parts.push(block.meta.summary)
      }
      if (block.meta.truncated) {
        parts.push(zh ? '已截断' : 'Truncated')
      }
      if (parts.length > 0) {
        suffix = ` · ${parts.join(' · ')}`
      }
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
