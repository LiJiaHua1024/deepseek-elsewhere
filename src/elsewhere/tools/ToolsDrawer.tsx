import clsx from 'clsx'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useIsMobile } from '../../app/viewport.js'
import { IconChevronRightOutline14 } from '../../components/base/icons.js'
import { openSettings } from '../../components/settings/settingsDialogState.js'
import {
  getEnabledMcpToolsCount,
  setMcpServerEnabled,
  useMcpServers,
} from '../mcp/config.js'
import {
  setHistorySearchEnabled,
  useBuiltinToolsConfig,
} from '../python/config.js'
import {
  cancelPyodideDownload,
  refreshPyodideStatus,
  togglePythonTool,
  usePyodideRuntime,
} from '../python/runtimeState.js'
import { useIsZh } from '../text.js'
import { closeToolsDrawer, useToolsDrawer } from './toolsDrawerState.js'
import styles from './ToolsDrawer.module.css'

export const ToolsDrawer = () => {
  const open = useToolsDrawer((state) => state.open)
  if (!open) {
    return null
  }
  return <ToolsDrawerContent />
}

const ToolsDrawerContent = () => {
  const zh = useIsZh()
  const isMobile = useIsMobile()
  const bottomSheet = isMobile || Boolean(android)
  const { pythonEnabled, historySearchEnabled } = useBuiltinToolsConfig()
  const pyodide = usePyodideRuntime()
  const servers = useMcpServers((state) => state.servers)

  useAndroidBackInterception(true)

  useEffect(() => {
    refreshPyodideStatus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeToolsDrawer()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const pythonChecked = android
    ? pyodide.installed
      ? pythonEnabled
      : pyodide.downloading || pyodide.pendingAutoEnable
    : pythonEnabled

  const progressPct = Math.round(Math.max(0, Math.min(1, pyodide.progress)) * 100)

  const handleTogglePython = () => {
    if (android && pyodide.downloading && !pyodide.installed) {
      cancelPyodideDownload()
      return
    }
    togglePythonTool(!(pythonEnabled && pyodide.installed))
  }

  return createPortal(
    <div
      className={clsx(styles.overlay, bottomSheet && styles.sheetOverlay)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeToolsDrawer()
        }
      }}
    >
      <section
        className={clsx(styles.panel, bottomSheet && styles.sheet)}
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '工具' : 'Tools'}
      >
        {bottomSheet ? <div className={styles.handle} aria-hidden="true" /> : null}
        <header className={styles.header}>
          <h2 className={styles.title}>{zh ? '工具' : 'Tools'}</h2>
          <button type="button" className={styles.doneButton} onClick={closeToolsDrawer}>
            {zh ? '完成' : 'Done'}
          </button>
        </header>

        <div className={styles.group}>
          <div className={styles.groupTitle}>{zh ? '内置工具' : 'Built-in tools'}</div>
          <div className={styles.card}>
            <div className={styles.rowWrap}>
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <div className={styles.rowLabel}>{zh ? 'Python 执行' : 'Python execution'}</div>
                  {android ? (
                    pyodide.downloading ? (
                      <div className={styles.rowSubtitle}>
                        {zh ? '正在准备运行环境…' : 'Preparing runtime...'}
                      </div>
                    ) : pyodide.error ? (
                      <div className={styles.errorText}>{pyodide.error}</div>
                    ) : pyodide.installed ? (
                      <div className={styles.rowSubtitle}>{zh ? '已缓存' : 'Cached'}</div>
                    ) : (
                      <div className={styles.rowSubtitle}>
                        {zh ? '需下载约 6 MB' : 'Downloads ~6 MB'}
                      </div>
                    )
                  ) : null}
                </div>
                <button
                  type="button"
                  className={styles.switch}
                  role="switch"
                  aria-label={zh ? 'Python 执行' : 'Python execution'}
                  aria-checked={pythonChecked}
                  onClick={handleTogglePython}
                >
                  <span />
                </button>
              </div>
              {android && pyodide.downloading ? (
                <div className={styles.progressBox}>
                  <div className={styles.progressTrack}>
                    <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
                  </div>
                  <span className={styles.progressPct}>{progressPct}%</span>
                  <button
                    type="button"
                    className={styles.cancelDownload}
                    onClick={cancelPyodideDownload}
                  >
                    {zh ? '取消' : 'Cancel'}
                  </button>
                </div>
              ) : null}
            </div>

            <div className={styles.rowWrap}>
              <div className={styles.row}>
                <div className={styles.rowText}>
                  <div className={styles.rowLabel}>{zh ? '历史对话检索' : 'Search history'}</div>
                </div>
                <button
                  type="button"
                  className={styles.switch}
                  role="switch"
                  aria-label={zh ? '历史对话检索' : 'Search history'}
                  aria-checked={historySearchEnabled}
                  onClick={() => setHistorySearchEnabled(!historySearchEnabled)}
                >
                  <span />
                </button>
              </div>
            </div>
          </div>
        </div>

        {servers.length > 0 ? (
          <div className={styles.group}>
            <div className={styles.groupTitle}>{zh ? 'MCP 服务' : 'MCP servers'}</div>
            <div className={styles.card}>
              {servers.map((server) => {
                const count = getEnabledMcpToolsCount(server)
                return (
                  <div key={server.id} className={styles.rowWrap}>
                    <div className={styles.row}>
                      <div className={styles.rowText}>
                        <div className={styles.rowLabel}>{server.name}</div>
                        <div className={styles.rowSubtitle}>
                          {zh
                            ? `${count} 个工具`
                            : `${count} ${count === 1 ? 'tool' : 'tools'}`}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={styles.switch}
                        role="switch"
                        aria-label={server.name}
                        aria-checked={server.enabled}
                        onClick={() => setMcpServerEnabled(server.id, !server.enabled)}
                      >
                        <span />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}

        <button
          type="button"
          className={styles.manageButton}
          onClick={() => {
            closeToolsDrawer()
            openSettings('tools')
          }}
        >
          <span>{zh ? '管理搜索与工具' : 'Manage search & tools'}</span>
          <IconChevronRightOutline14 />
        </button>
      </section>
    </div>,
    document.body
  )
}
