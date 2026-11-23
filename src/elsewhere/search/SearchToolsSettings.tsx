import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { IconChevronRightOutline14 } from '../../components/base/icons.js'
import { Select } from '../../components/base/Select.js'
import { useSettings } from '../../services/settings.js'
import { useMcpServers } from '../mcp/config.js'
import {
  McpServerAddView,
  McpServerDetailView,
  McpServerListView,
} from '../mcp/McpSettingsViews.js'
import { setHistorySearchEnabled, useBuiltinToolsConfig } from '../python/config.js'
import {
  cancelPyodideDownload,
  clearPyodideCache,
  refreshPyodideStatus,
  togglePythonTool,
  usePyodideRuntime,
} from '../python/runtimeState.js'
import type { SearchEngineKeyId } from '../tools/types.js'
import { useIsZh } from '../text.js'
import {
  getSearchToolsRuntimeConfig,
  normalizeHttpBaseUrl,
  SEARCH_ENGINE_OPTIONS,
  setSearchEngine,
  setSearchEngineApiKey,
  setSearxngUrl,
  setUseExternalOnOfficial,
  setWebFetchMode,
  useSearchToolsConfig,
} from './config.js'
import { testSearchEngine } from './providers.js'
import styles from './SearchToolsSettings.module.css'

type TestStatus =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

type SubView =
  | { kind: 'main' }
  | { kind: 'mcpList' }
  | { kind: 'mcpAdd' }
  | { kind: 'mcpDetail'; serverId: string }

export const SearchToolsSettings = ({
  variant,
  onSelectWebFetchMode,
  onOpenMcpList,
}: {
  variant: 'web' | 'android'
  onSelectWebFetchMode?: () => void
  onOpenMcpList?: () => void
}) => {
  const zh = useIsZh()
  const officialApiKey = useSettings((state) => state.apiKey)
  const { engine, apiKeys, searxngUrl, webFetchMode, useExternalOnOfficial } =
    useSearchToolsConfig()
  const { pythonEnabled, historySearchEnabled } = useBuiltinToolsConfig()
  const pyodide = usePyodideRuntime()
  const mcpServers = useMcpServers((state) => state.servers)
  const [subView, setSubView] = useState<SubView>({ kind: 'main' })
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  const cancelTest = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  useEffect(() => {
    refreshPyodideStatus()
    return cancelTest
  }, [])

  const resetTest = () => {
    cancelTest()
    setTestStatus({ kind: 'idle' })
  }

  const runTest = async () => {
    cancelTest()
    if (engine === 'searxng') {
      if (!normalizeHttpBaseUrl(searxngUrl)) {
        setTestStatus({
          kind: 'error',
          message: zh ? '请填写有效的实例地址' : 'Enter a valid instance URL',
        })
        return
      }
    } else if (engine !== 'deepseek') {
      if (!apiKeys[engine]?.trim()) {
        setTestStatus({
          kind: 'error',
          message: zh ? '请先填写 API Key' : 'Enter API Key first',
        })
        return
      }
    }

    const controller = new AbortController()
    abortRef.current = controller
    setTestStatus({ kind: 'testing' })
    try {
      await testSearchEngine(getSearchToolsRuntimeConfig(officialApiKey), controller.signal)
      if (abortRef.current === controller) {
        abortRef.current = null
        setTestStatus({
          kind: 'ok',
          message: zh ? '连接正常' : 'Connected',
        })
      }
    } catch (error) {
      if (controller.signal.aborted || abortRef.current !== controller) {
        return
      }
      abortRef.current = null
      const detail = error instanceof Error ? error.message : String(error)
      setTestStatus({
        kind: 'error',
        message: zh ? `连接失败：${detail}` : `Failed: ${detail}`,
      })
    }
  }

  const isKeyedEngine =
    engine === 'bocha' || engine === 'exa' || engine === 'tavily' || engine === 'brave'
  const currentApiKey = isKeyedEngine ? (apiKeys[engine as SearchEngineKeyId] ?? '') : ''
  const fetchModeLabel = webFetchMode === 'auto' ? (zh ? '自动' : 'Auto') : zh ? '关闭' : 'Off'
  const officialLabel = zh ? '官方接口也使用此搜索' : 'Use for official API'

  const pythonChecked = android
    ? pyodide.installed
      ? pythonEnabled
      : pyodide.downloading || pyodide.pendingAutoEnable
    : pythonEnabled
  const progressPct = Math.round(Math.max(0, Math.min(1, pyodide.progress)) * 100)
  const enabledMcpServersCount = mcpServers.filter((server) => server.enabled).length

  if (variant === 'web' && subView.kind !== 'main') {
    const activeServer =
      subView.kind === 'mcpDetail'
        ? mcpServers.find((item) => item.id === subView.serverId)
        : undefined
    const backTitle =
      subView.kind === 'mcpAdd'
        ? zh
          ? '添加 MCP 服务'
          : 'Add MCP server'
        : subView.kind === 'mcpDetail'
          ? (activeServer?.name ?? (zh ? 'MCP 服务' : 'MCP server'))
          : zh
            ? 'MCP 服务'
            : 'MCP servers'

    return (
      <div className={styles.container}>
        <div className={styles.subHeader}>
          <button
            type="button"
            className={styles.subBackButton}
            onClick={() =>
              setSubView(subView.kind === 'mcpList' ? { kind: 'main' } : { kind: 'mcpList' })
            }
          >
            <IconChevronRightOutline14 />
            <span>{backTitle}</span>
          </button>
        </div>
        {subView.kind === 'mcpList' ? (
          <McpServerListView
            variant="web"
            onAdd={() => setSubView({ kind: 'mcpAdd' })}
            onSelectServer={(serverId) => setSubView({ kind: 'mcpDetail', serverId })}
          />
        ) : null}
        {subView.kind === 'mcpAdd' ? (
          <McpServerAddView
            variant="web"
            onSaved={() => setSubView({ kind: 'mcpList' })}
          />
        ) : null}
        {subView.kind === 'mcpDetail' ? (
          <McpServerDetailView
            variant="web"
            serverId={subView.serverId}
            onDeleted={() => setSubView({ kind: 'mcpList' })}
          />
        ) : null}
      </div>
    )
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>{zh ? '搜索引擎' : 'Search engine'}</div>
        <div className={styles.chips} role="radiogroup" aria-label={zh ? '搜索引擎' : 'Search engine'}>
          {SEARCH_ENGINE_OPTIONS.map((option) => {
            const selected = engine === option.id
            const label = !zh && option.enLabel ? option.enLabel : option.label
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={clsx(styles.chip, selected && styles.chipSelected)}
                onClick={() => {
                  setSearchEngine(option.id)
                  resetTest()
                }}
              >
                {label}
              </button>
            )
          })}
        </div>

        <div className={styles.engineForm}>
          {engine === 'deepseek' ? (
            <div
              className={clsx(
                styles.statusRow,
                !officialApiKey?.trim() && styles.statusMissing
              )}
            >
              {officialApiKey?.trim()
                ? zh
                  ? '使用当前 DeepSeek API Key'
                  : 'Using current DeepSeek API Key'
                : zh
                  ? '需先填写 DeepSeek API Key'
                  : 'DeepSeek API Key required'}
            </div>
          ) : engine === 'searxng' ? (
            <div className={styles.inputRow}>
              <input
                type="url"
                inputMode="url"
                className={styles.input}
                aria-label={zh ? '实例地址' : 'Instance URL'}
                placeholder="https://..."
                value={searxngUrl}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSearxngUrl(event.target.value)
                  resetTest()
                }}
              />
              <button
                type="button"
                className={styles.testButton}
                disabled={testStatus.kind === 'testing'}
                onClick={() => void runTest()}
              >
                {testStatus.kind === 'testing'
                  ? zh
                    ? '测试中'
                    : 'Testing'
                  : zh
                    ? '测试'
                    : 'Test'}
              </button>
            </div>
          ) : (
            <div className={styles.inputRow}>
              <input
                type="password"
                className={styles.input}
                aria-label="API Key"
                placeholder="API Key"
                value={currentApiKey}
                autoCapitalize="off"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  setSearchEngineApiKey(engine as SearchEngineKeyId, event.target.value)
                  resetTest()
                }}
              />
              <button
                type="button"
                className={styles.testButton}
                disabled={testStatus.kind === 'testing'}
                onClick={() => void runTest()}
              >
                {testStatus.kind === 'testing'
                  ? zh
                    ? '测试中'
                    : 'Testing'
                  : zh
                    ? '测试'
                    : 'Test'}
              </button>
            </div>
          )}

          {testStatus.kind === 'ok' || testStatus.kind === 'error' ? (
            <div
              className={clsx(
                styles.testFeedback,
                testStatus.kind === 'ok' ? styles.testOk : styles.testError
              )}
              role="status"
            >
              {testStatus.message}
            </div>
          ) : null}
        </div>
      </div>

      <div className={variant === 'android' ? styles.androidFlatCard : styles.card}>
        {variant === 'android' && onSelectWebFetchMode ? (
          <button
            type="button"
            className={clsx(styles.row, styles.androidRow)}
            onClick={onSelectWebFetchMode}
          >
            <span className={styles.rowLabel}>{zh ? '网页读取' : 'Web page reading'}</span>
            <span className={styles.rowValueGroup}>
              <span>{fetchModeLabel}</span>
              <IconChevronRightOutline14 />
            </span>
          </button>
        ) : (
          <div className={styles.row}>
            <span className={styles.rowLabel}>{zh ? '网页读取' : 'Web page reading'}</span>
            <Select
              ariaLabel={zh ? '网页读取' : 'Web page reading'}
              value={webFetchMode}
              options={[
                { value: 'auto', label: zh ? '自动' : 'Auto' },
                { value: 'off', label: zh ? '关闭' : 'Off' },
              ]}
              onChange={setWebFetchMode}
            />
          </div>
        )}
      </div>

      <div className={variant === 'android' ? styles.androidFlatCard : styles.card}>
        <div className={clsx(styles.row, variant === 'android' && styles.androidRow)}>
          <div className={styles.rowText}>
            <div className={styles.rowLabel}>{officialLabel}</div>
            <div className={styles.rowSubtitle}>
              {zh ? '关闭时使用 DeepSeek 内置搜索' : 'Uses DeepSeek built-in search when off'}
            </div>
          </div>
          <button
            type="button"
            className={styles.switch}
            role="switch"
            aria-label={officialLabel}
            aria-checked={useExternalOnOfficial}
            onClick={() => setUseExternalOnOfficial(!useExternalOnOfficial)}
          >
            <span />
          </button>
        </div>
      </div>

      <div className={clsx(variant === 'android' ? styles.androidFlatCard : styles.card, styles.rowList)}>
        <div className={styles.cardHeader}>{zh ? '内置工具' : 'Built-in tools'}</div>
        <div>
          <div className={clsx(styles.row, variant === 'android' ? styles.androidRow : styles.webRow)}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>{zh ? 'Python 执行' : 'Python execution'}</div>
              {android ? (
                pyodide.downloading ? (
                  <div className={styles.rowSubtitle}>
                    {zh ? '正在准备运行环境…' : 'Preparing runtime...'}
                  </div>
                ) : pyodide.error ? (
                  <div className={clsx(styles.rowSubtitle, styles.testError)}>{pyodide.error}</div>
                ) : pyodide.installed ? (
                  <div className={styles.rowSubtitle}>
                    <span>{zh ? '已缓存' : 'Cached'}</span>
                    <button
                      type="button"
                      className={styles.inlineAction}
                      onClick={clearPyodideCache}
                    >
                      {zh ? '清除' : 'Clear'}
                    </button>
                  </div>
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
              onClick={() => {
                if (android && pyodide.downloading && !pyodide.installed) {
                  cancelPyodideDownload()
                } else {
                  togglePythonTool(!(pythonEnabled && pyodide.installed))
                }
              }}
            >
              <span />
            </button>
          </div>
          {android && pyodide.downloading ? (
            <div className={styles.progressRow}>
              <div className={styles.progressTrack}>
                <div className={styles.progressFill} style={{ width: `${progressPct}%` }} />
              </div>
              <span className={styles.progressPct}>{progressPct}%</span>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={cancelPyodideDownload}
              >
                {zh ? '取消' : 'Cancel'}
              </button>
            </div>
          ) : null}
        </div>

        <div className={styles.rowDivider}>
          <div className={clsx(styles.row, variant === 'android' ? styles.androidRow : styles.webRow)}>
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

      <div className={variant === 'android' ? styles.androidFlatCard : clsx(styles.card, styles.rowList)}>
        <button
          type="button"
          className={clsx(styles.row, variant === 'android' ? styles.androidRow : styles.webRow)}
          onClick={() => {
            if (onOpenMcpList) {
              onOpenMcpList()
            } else {
              setSubView({ kind: 'mcpList' })
            }
          }}
        >
          <span className={styles.rowLabel}>{zh ? 'MCP 服务' : 'MCP servers'}</span>
          <span className={styles.rowValueGroup}>
            <span>
              {mcpServers.length === 0
                ? zh
                  ? '未添加'
                  : 'None added'
                : zh
                  ? `${enabledMcpServersCount} 个已启用`
                  : `${enabledMcpServersCount} enabled`}
            </span>
            <IconChevronRightOutline14 />
          </span>
        </button>
      </div>
    </div>
  )
}
