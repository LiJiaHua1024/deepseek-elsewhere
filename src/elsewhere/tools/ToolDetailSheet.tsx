import clsx from 'clsx'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconCloseOutline16 } from '../../components/base/icons.js'
import { PythonImageGallery } from '../python/PythonCharts.js'
import { getSearchEngineLabel } from '../search/config.js'
import { useIsZh } from '../text.js'
import { closeToolDetail, useToolDetail } from './toolDetailState.js'
import type { ClientToolCallBlock } from './types.js'
import styles from './ToolDetailSheet.module.css'

const formatServiceLabel = (block: ClientToolCallBlock, zh: boolean): string => {
  if (block.meta?.kind === 'search') {
    const engine = getSearchEngineLabel(block.meta.engine, zh)
    return zh ? `内置搜索 · ${engine}` : `Built-in Search · ${engine}`
  }
  if (block.name === 'web_search') {
    return zh ? '内置搜索' : 'Built-in Search'
  }
  if (block.name === 'web_fetch') {
    return zh ? '内置网页读取' : 'Built-in Page Fetch'
  }
  if (block.name === 'run_python') {
    return zh ? '内置 Python' : 'Built-in Python'
  }
  if (block.name === 'search_history') {
    return zh ? '内置历史检索' : 'Built-in History Search'
  }
  if (block.name === 'memory_read' || block.name === 'memory_search' || block.name === 'memory_write') {
    return zh ? '聊天记忆' : 'Chat Memory'
  }
  return block.serverName || (zh ? '内置工具' : 'Built-in Tool')
}

const formatStatusAndDuration = (block: ClientToolCallBlock, zh: boolean): string => {
  let statusText: string
  switch (block.status) {
    case 'awaiting_confirmation':
      statusText = zh ? '等待确认' : 'Awaiting confirmation'
      break
    case 'running':
      statusText = zh ? '运行中' : 'Running'
      break
    case 'done':
      statusText = zh ? '已完成' : 'Done'
      break
    case 'error':
      statusText = zh ? '失败' : 'Failed'
      break
    case 'denied':
      statusText = zh ? '已拒绝' : 'Denied'
      break
    case 'stopped':
      statusText = zh ? '已停止' : 'Stopped'
      break
    case 'aborted_loop':
      statusText = zh ? '已停止重复调用' : 'Stopped'
      break
  }
  if (block.endedAt === undefined) {
    return statusText
  }
  const ms = Math.max(0, block.endedAt - block.startedAt)
  const durationText =
    ms < 100
      ? zh
        ? '< 0.1 秒'
        : '< 0.1s'
      : ms < 10_000
        ? zh
          ? `${(ms / 1000).toFixed(1)} 秒`
          : `${(ms / 1000).toFixed(1)}s`
        : zh
          ? `${Math.round(ms / 1000)} 秒`
          : `${Math.round(ms / 1000)}s`
  return `${statusText} · ${durationText}`
}

export const ToolDetailSheet = () => {
  const block = useToolDetail((state) => state.block)
  if (!block) {
    return null
  }
  return <ToolDetailContent block={block} />
}

const ToolDetailContent = ({ block }: { block: ClientToolCallBlock }) => {
  const zh = useIsZh()
  const isMobile = useIsMobile()
  const bottomSheet = isMobile || Boolean(android)

  useAndroidBackInterception(true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeToolDetail()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const argsText = block.rawInput ?? JSON.stringify(block.input, null, 2)
  const resultText =
    block.error ??
    block.output ??
    (block.status === 'awaiting_confirmation'
      ? zh
        ? '等待确认…'
        : 'Awaiting confirmation...'
      : block.status === 'running'
        ? zh
          ? '执行中…'
          : 'Running...'
        : '')
  const truncated =
    Boolean(block.meta && 'truncated' in block.meta && block.meta.truncated)
  const pythonImages = block.meta?.kind === 'python' ? (block.meta.images ?? []) : []

  return createPortal(
    <div
      className={clsx(styles.overlay, bottomSheet && styles.sheetOverlay)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeToolDetail()
        }
      }}
    >
      <section
        className={clsx(styles.panel, bottomSheet && styles.sheet)}
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '工具调用详情' : 'Tool Call Details'}
      >
        {bottomSheet ? <div className={styles.handle} aria-hidden="true" /> : null}
        <header className={styles.header}>
          <h2 className={styles.title}>{zh ? '工具调用详情' : 'Tool Call Details'}</h2>
          {!bottomSheet ? (
            <button
              type="button"
              className={styles.closeButton}
              aria-label={zh ? '关闭' : 'Close'}
              onClick={closeToolDetail}
            >
              <IconCloseOutline16 />
            </button>
          ) : null}
        </header>

        <dl className={styles.metaList}>
          <div className={styles.metaRow}>
            <dt>{zh ? '来源服务' : 'Service'}</dt>
            <dd>{formatServiceLabel(block, zh)}</dd>
          </div>
          <div className={styles.metaRow}>
            <dt>{zh ? '工具名称' : 'Tool'}</dt>
            <dd className={styles.mono}>{block.displayName ?? block.name}</dd>
          </div>
          <div className={styles.metaRow}>
            <dt>{zh ? '状态与耗时' : 'Status'}</dt>
            <dd className={clsx(block.status === 'error' && styles.errorText)}>
              <span>{formatStatusAndDuration(block, zh)}</span>
              {truncated ? (
                <span className={styles.truncatedBadge}>{zh ? '已截断' : 'Truncated'}</span>
              ) : null}
            </dd>
          </div>
        </dl>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>{zh ? '传入参数' : 'Arguments'}</div>
          <pre className={styles.codeBox}>{argsText}</pre>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionLabel}>{block.name === 'memory_write' ? (zh ? '写入内容' : 'Write diff') : zh ? '返回结果' : 'Result'}</div>
          <pre
            className={clsx(
              styles.codeBox,
              (block.status === 'error' || block.status === 'denied') && styles.errorText
            )}
          >
            {resultText}
          </pre>
          {pythonImages.length > 0 ? <PythonImageGallery images={pythonImages} compact /> : null}
        </div>
      </section>
    </div>,
    document.body
  )
}
