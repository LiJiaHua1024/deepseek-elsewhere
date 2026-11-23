import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { useIsZh } from '../text.js'
import {
  addMcpServer,
  getEnabledMcpToolsCount,
  normalizeMcpUrl,
  removeMcpServer,
  setMcpServerAutoApprove,
  setMcpServerCachedTools,
  setMcpServerEnabled,
  setMcpToolEnabled,
  useMcpServers,
} from './config.js'
import { mcpClient } from './protocol.js'
import type { McpCachedTool, McpServerAuth, McpServerConfig } from './types.js'
import styles from './McpSettingsViews.module.css'

type AuthKind = McpServerAuth['type']

type StatusFeedback =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

export const McpServerListView = ({
  variant,
  onAdd,
  onSelectServer,
}: {
  variant: 'web' | 'android'
  onAdd: () => void
  onSelectServer: (serverId: string) => void
}) => {
  const zh = useIsZh()
  const servers = useMcpServers((state) => state.servers)

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {servers.length === 0 ? (
        <div className={clsx(styles.card, styles.emptyCard)}>
          <p className={styles.emptyText}>
            {zh ? '尚未添加 MCP 服务' : 'No MCP servers added yet'}
          </p>
          <button type="button" className={styles.primaryButton} onClick={onAdd}>
            {zh ? '+ 添加服务' : '+ Add server'}
          </button>
        </div>
      ) : (
        <>
          <div className={styles.card}>
            {servers.map((server) => {
              const total = server.cachedTools.length
              const enabledCount = getEnabledMcpToolsCount(server)
              const subtitle = !server.enabled
                ? zh
                  ? '已停用'
                  : 'Disabled'
                : total === 0
                  ? zh
                    ? '未读取工具列表'
                    : 'No tools loaded'
                  : zh
                    ? `${enabledCount} / ${total} 个工具已启用`
                    : `${enabledCount} of ${total} tools enabled`

              return (
                <div key={server.id} className={styles.rowWrap}>
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={styles.rowButton}
                      onClick={() => onSelectServer(server.id)}
                    >
                      <span className={styles.rowLabel}>{server.name}</span>
                      <span className={styles.rowSubtitle}>{subtitle}</span>
                    </button>
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
          {variant === 'web' ? (
            <div className={styles.actionsRow}>
              <button type="button" className={styles.secondaryButton} onClick={onAdd}>
                {zh ? '+ 添加服务' : '+ Add server'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

export const McpServerAddView = ({
  variant,
  formId = 'mcp-add-form',
  onSaved,
}: {
  variant: 'web' | 'android'
  formId?: string
  onSaved: () => void
}) => {
  const zh = useIsZh()
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [authType, setAuthType] = useState<AuthKind>('none')
  const [bearerToken, setBearerToken] = useState('')
  const [headerRows, setHeaderRows] = useState<{ key: string; value: string }[]>([
    { key: '', value: '' },
  ])
  const [status, setStatus] = useState<StatusFeedback>({ kind: 'idle' })
  const [loadedTools, setLoadedTools] = useState<{
    signature: string
    tools: McpCachedTool[]
    connectedAt: number
  } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
      mcpClient.closeRuntime('draft-mcp-preview')
    }
  }, [])

  const buildAuth = (): McpServerAuth => {
    if (authType === 'bearer') {
      return { type: 'bearer', token: bearerToken.trim() }
    }
    if (authType === 'headers') {
      return {
        type: 'headers',
        headers: headerRows
          .map((row) => ({ key: row.key.trim(), value: row.value.trim() }))
          .filter((row) => row.key !== ''),
      }
    }
    return { type: 'none' }
  }

  const testAndFetchTools = async () => {
    abortRef.current?.abort()
    const normalized = normalizeMcpUrl(url)
    if (!normalized) {
      setStatus({
        kind: 'error',
        message: zh
          ? '请输入有效的 http:// 或 https:// 地址'
          : 'Enter a valid http:// or https:// URL',
      })
      return
    }
    const auth = buildAuth()
    const signature = JSON.stringify({ url: normalized, auth })
    const draftServer: McpServerConfig = {
      id: 'draft-mcp-preview',
      name: name.trim() || new URL(normalized).hostname,
      url: normalized,
      auth,
      enabled: true,
      autoApprove: false,
      disabledTools: [],
      cachedTools: [],
    }
    const controller = new AbortController()
    abortRef.current = controller
    setStatus({ kind: 'busy' })

    try {
      const { tools } = await mcpClient.connectAndListTools(draftServer, controller.signal)
      await mcpClient.terminateSession(draftServer).catch(() => {})
      if (abortRef.current !== controller) {
        return
      }
      abortRef.current = null
      setLoadedTools({ signature, tools, connectedAt: Date.now() })
      setStatus({
        kind: 'ok',
        message: zh
          ? `已读取 ${tools.length} 个工具`
          : `Loaded ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`,
      })
    } catch (error) {
      mcpClient.closeRuntime(draftServer.id)
      if (controller.signal.aborted || abortRef.current !== controller) {
        return
      }
      abortRef.current = null
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const normalized = normalizeMcpUrl(url)
    if (!normalized) {
      setStatus({
        kind: 'error',
        message: zh
          ? '请输入有效的 http:// 或 https:// 地址'
          : 'Enter a valid http:// or https:// URL',
      })
      return
    }
    const auth = buildAuth()
    const signature = JSON.stringify({ url: normalized, auth })
    const matchedLoaded = loadedTools?.signature === signature ? loadedTools : null
    addMcpServer({
      name: name.trim(),
      url: normalized,
      auth,
      cachedTools: matchedLoaded?.tools ?? [],
      ...(matchedLoaded ? { lastConnectedAt: matchedLoaded.connectedAt } : {}),
    })
    onSaved()
  }

  return (
    <form
      id={formId}
      className={clsx(styles.container, variant === 'android' && styles.androidContainer)}
      onSubmit={handleSubmit}
    >
      <div className={clsx(styles.card, styles.paddedCard)}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor={`${formId}-name`}>
            {zh ? '名称（选填）' : 'Name (optional)'}
          </label>
          <input
            id={`${formId}-name`}
            type="text"
            className={styles.input}
            value={name}
            placeholder={zh ? '例如：文档检索' : 'e.g. Docs search'}
            onChange={(event) => setName(event.target.value)}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel} htmlFor={`${formId}-url`}>
            {zh ? '服务地址' : 'Server URL'}
          </label>
          <input
            id={`${formId}-url`}
            type="url"
            className={styles.input}
            value={url}
            placeholder="https://example.com"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            onChange={(event) => {
              setUrl(event.target.value)
              if (status.kind !== 'idle') {
                setStatus({ kind: 'idle' })
              }
            }}
          />
        </div>

        <div className={styles.fieldGroup}>
          <div className={styles.fieldLabel}>{zh ? '认证方式' : 'Authentication'}</div>
          <div className={styles.chips} role="radiogroup" aria-label={zh ? '认证方式' : 'Authentication'}>
            {(
              [
                { id: 'none', label: zh ? '无' : 'None' },
                { id: 'bearer', label: 'Bearer Token' },
                { id: 'headers', label: zh ? '自定义请求头' : 'Custom headers' },
              ] as const
            ).map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={authType === option.id}
                className={clsx(styles.chip, authType === option.id && styles.chipSelected)}
                onClick={() => setAuthType(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        {authType === 'bearer' ? (
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel} htmlFor={`${formId}-token`}>
              Token
            </label>
            <input
              id={`${formId}-token`}
              type="password"
              className={styles.input}
              value={bearerToken}
              placeholder="Bearer token"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setBearerToken(event.target.value)}
            />
          </div>
        ) : null}

        {authType === 'headers' ? (
          <div className={styles.fieldGroup}>
            {headerRows.map((row, idx) => (
              <div key={idx} className={styles.headerPair}>
                <input
                  type="text"
                  className={styles.input}
                  value={row.key}
                  aria-label={zh ? `请求头名称 ${idx + 1}` : `Header name ${idx + 1}`}
                  placeholder={zh ? 'Header 名称' : 'Header name'}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(event) => {
                    const value = event.target.value
                    setHeaderRows((current) =>
                      current.map((entry, i) => (i === idx ? { ...entry, key: value } : entry))
                    )
                  }}
                />
                <input
                  type="text"
                  className={styles.input}
                  value={row.value}
                  aria-label={zh ? `请求头值 ${idx + 1}` : `Header value ${idx + 1}`}
                  placeholder={zh ? 'Header 值' : 'Header value'}
                  spellCheck={false}
                  autoCapitalize="none"
                  onChange={(event) => {
                    const value = event.target.value
                    setHeaderRows((current) =>
                      current.map((entry, i) => (i === idx ? { ...entry, value } : entry))
                    )
                  }}
                />
                {headerRows.length > 1 ? (
                  <button
                    type="button"
                    className={styles.removeHeader}
                    aria-label={zh ? '移除' : 'Remove'}
                    onClick={() =>
                      setHeaderRows((current) => current.filter((_, i) => i !== idx))
                    }
                  >
                    ×
                  </button>
                ) : null}
              </div>
            ))}
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setHeaderRows((current) => [...current, { key: '', value: '' }])}
            >
              {zh ? '+ 添加请求头' : '+ Add header'}
            </button>
          </div>
        ) : null}
      </div>

      <div className={styles.actionsRow}>
        <button
          type="button"
          className={styles.secondaryButton}
          disabled={status.kind === 'busy'}
          onClick={() => void testAndFetchTools()}
        >
          {status.kind === 'busy'
            ? zh
              ? '正在读取…'
              : 'Connecting...'
            : zh
              ? '连接并读取工具'
              : 'Connect & load tools'}
        </button>
        {variant === 'web' ? (
          <button type="submit" className={styles.primaryButton}>
            {zh ? '保存' : 'Save'}
          </button>
        ) : null}
      </div>

      {status.kind === 'ok' || status.kind === 'error' ? (
        <div
          className={clsx(
            styles.feedback,
            status.kind === 'ok' ? styles.feedbackOk : styles.feedbackError
          )}
          role="status"
        >
          {status.message}
        </div>
      ) : null}
    </form>
  )
}

export const McpServerDetailView = ({
  variant,
  serverId,
  onDeleted,
}: {
  variant: 'web' | 'android'
  serverId: string
  onDeleted: () => void
}) => {
  const zh = useIsZh()
  const server = useMcpServers((state) => state.servers.find((item) => item.id === serverId))
  const [refreshStatus, setRefreshStatus] = useState<StatusFeedback>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
      abortRef.current = null
    }
  }, [serverId])

  if (!server) {
    return null
  }

  const disabledSet = new Set(server.disabledTools)

  const handleRefresh = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setRefreshStatus({ kind: 'busy' })

    try {
      const { tools } = await mcpClient.connectAndListTools(server, controller.signal)
      if (abortRef.current !== controller) {
        return
      }
      abortRef.current = null
      setMcpServerCachedTools(server.id, tools)
      setRefreshStatus({
        kind: 'ok',
        message: zh
          ? `已更新 ${tools.length} 个工具`
          : `Updated ${tools.length} ${tools.length === 1 ? 'tool' : 'tools'}`,
      })
    } catch (error) {
      if (controller.signal.aborted || abortRef.current !== controller) {
        return
      }
      abortRef.current = null
      setRefreshStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const handleDelete = () => {
    void mcpClient.terminateSession(server).catch(() => {})
    removeMcpServer(server.id)
    onDeleted()
  }

  const statusText = !server.enabled
    ? zh
      ? '已停用'
      : 'Disabled'
    : server.lastConnectedAt
      ? zh
        ? '已连接'
        : 'Connected'
      : zh
        ? '未连接'
        : 'Not connected'

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.card}>
        <div className={styles.rowWrap}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>{zh ? '服务地址' : 'Server URL'}</div>
              <div className={clsx(styles.rowSubtitle, styles.wrapSubtitle)}>{server.url}</div>
            </div>
            <span className={styles.rowSubtitle}>{statusText}</span>
          </div>
        </div>

        <div className={styles.rowWrap}>
          <div className={styles.row}>
            <div className={styles.rowText}>
              <div className={styles.rowLabel}>{zh ? '自动允许调用' : 'Auto-approve calls'}</div>
              <div className={clsx(styles.rowSubtitle, styles.wrapSubtitle)}>
                {zh
                  ? '关闭时，调用此服务工具前会先确认'
                  : 'Ask before calling tools on this server when off'}
              </div>
            </div>
            <button
              type="button"
              className={styles.switch}
              role="switch"
              aria-label={zh ? '自动允许调用' : 'Auto-approve calls'}
              aria-checked={server.autoApprove}
              onClick={() => setMcpServerAutoApprove(server.id, !server.autoApprove)}
            >
              <span />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.sectionHeader}>
        <span className={styles.sectionTitle}>
          {zh
            ? `可用工具（${server.cachedTools.length}）`
            : `Available tools (${server.cachedTools.length})`}
        </span>
        <button
          type="button"
          className={styles.refreshButton}
          disabled={refreshStatus.kind === 'busy'}
          onClick={() => void handleRefresh()}
        >
          {refreshStatus.kind === 'busy'
            ? zh
              ? '刷新中…'
              : 'Refreshing...'
            : zh
              ? '刷新'
              : 'Refresh'}
        </button>
      </div>

      {refreshStatus.kind === 'ok' || refreshStatus.kind === 'error' ? (
        <div
          className={clsx(
            styles.feedback,
            refreshStatus.kind === 'ok' ? styles.feedbackOk : styles.feedbackError
          )}
          role="status"
        >
          {refreshStatus.message}
        </div>
      ) : null}

      {server.cachedTools.length > 0 ? (
        <div className={styles.card}>
          {server.cachedTools.map((tool) => {
            const checked = !disabledSet.has(tool.name)
            return (
              <div key={tool.name} className={styles.rowWrap}>
                <div className={styles.row}>
                  <div className={styles.rowText}>
                    <div className={styles.rowLabel}>{tool.name}</div>
                    {tool.description ? (
                      <div className={styles.rowSubtitle}>{tool.description}</div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className={styles.switch}
                    role="switch"
                    aria-label={tool.name}
                    aria-checked={checked}
                    onClick={() => setMcpToolEnabled(server.id, tool.name, !checked)}
                  >
                    <span />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className={clsx(styles.card, styles.emptyCard)}>
          <p className={styles.emptyText}>
            {zh ? '点击「刷新」获取可用工具列表' : 'Tap Refresh to load available tools'}
          </p>
        </div>
      )}

      <button type="button" className={styles.dangerButton} onClick={handleDelete}>
        {zh ? '删除此服务' : 'Delete server'}
      </button>
    </div>
  )
}
