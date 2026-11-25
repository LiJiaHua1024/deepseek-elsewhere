import clsx from 'clsx'
import { useState } from 'react'
import { useIsZh } from '../text.js'
import { resolveToolConfirmation, useToolConfirmations } from './confirmation.js'
import styles from './ToolConfirmationBar.module.css'

export const ToolConfirmationBar = ({ sessionId }: { sessionId: string | null }) => {
  const zh = useIsZh()
  const queue = useToolConfirmations((state) => state.queue)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const item = sessionId ? queue.find((entry) => entry.sessionId === sessionId) : undefined
  if (!item) {
    return null
  }

  const isMemoryWrite = item.toolName === 'memory_write'
  const expanded = isMemoryWrite || expandedId === item.id
  const targetLabel = isMemoryWrite
    ? item.memoryPreview?.path ??
      (typeof item.input.path === 'string' ? item.input.path : item.displayName)
    : item.serverName
      ? `${item.serverName} · ${item.displayName}`
      : item.displayName

  return (
    <div className={styles.bar} role="region" aria-label={zh ? '确认调用工具' : 'Confirm tool call'}>
      <div className={styles.header}>
        <div className={styles.titleGroup}>
          <span className={styles.title}>
            {isMemoryWrite
              ? zh
                ? '确认写入记忆'
                : 'Confirm memory write'
              : zh
                ? '确认调用工具'
                : 'Confirm tool call'}
          </span>
          <span className={styles.target}>{targetLabel}</span>
        </div>
        {!isMemoryWrite ? (
          <button
            type="button"
            className={styles.toggleButton}
            onClick={() => setExpandedId(expanded ? null : item.id)}
          >
            {expanded ? (zh ? '收起参数' : 'Hide args') : zh ? '查看参数' : 'View args'}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <pre className={styles.argsPreview}>
          {isMemoryWrite
            ? item.memoryPreview?.diffText ||
              item.memoryPreview?.message ||
              JSON.stringify(item.input, null, 2)
            : JSON.stringify(item.input, null, 2)}
        </pre>
      ) : null}

      <div className={styles.actions}>
        <button
          type="button"
          className={clsx(styles.button, styles.denyButton)}
          onClick={() => resolveToolConfirmation(item.id, 'deny')}
        >
          {zh ? '拒绝' : 'Deny'}
        </button>
        <button
          type="button"
          className={clsx(styles.button, styles.allowOnceButton)}
          onClick={() => resolveToolConfirmation(item.id, 'allow_once')}
        >
          {isMemoryWrite ? (zh ? '允许写入' : 'Allow write') : zh ? '允许一次' : 'Allow once'}
        </button>
        {!isMemoryWrite ? (
          <button
            type="button"
            className={clsx(styles.button, styles.allowSessionButton)}
            onClick={() => resolveToolConfirmation(item.id, 'allow_session')}
          >
            {zh ? '本会话允许' : 'Allow session'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
