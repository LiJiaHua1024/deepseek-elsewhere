import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import {
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconSearchOutline16,
} from '../../components/base/icons.js'
import { Modal } from '../../components/base/Modal.js'
import { Select } from '../../components/base/Select.js'
import { CHAT_API_FORMATS, type ChatApiFormat } from '../../services/api/chatConfig.js'
import { useSettings } from '../../services/settings.js'
import { setTitleModel, useElsewherePrefs } from '../preferences.js'
import { useIsZh } from '../text.js'
import {
  addCustomProvider,
  addManualModel,
  mergeProviderModels,
  removeCustomProvider,
  setProviderEnabled,
  toggleProviderModel,
  updateProvider,
  useModelProviders,
} from './config.js'
import {
  fetchProviderModels,
  normalizeProviderBaseUrl,
  testProviderConnection,
} from './fetchModels.js'
import styles from './ModelSettingsViews.module.css'

const FORMAT_OPTIONS = (Object.keys(CHAT_API_FORMATS) as ChatApiFormat[]).map((value) => ({
  value,
  label: CHAT_API_FORMATS[value],
}))

export const ModelProviderListView = ({
  variant,
  onAdd,
  onSelectProvider,
}: {
  variant: 'web' | 'android'
  onAdd: () => void
  onSelectProvider: (providerId: string) => void
}) => {
  const zh = useIsZh()
  const providers = useModelProviders((state) => state.providers)
  const officialApiKey = useSettings((state) => state.apiKey)
  const titleModel = useElsewherePrefs((state) => state.titleModel)
  const [titleDraft, setTitleDraft] = useState(titleModel)

  useEffect(() => {
    setTitleDraft(titleModel)
  }, [titleModel])

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.topBar}>
          <span className={styles.pageTitle}>{zh ? '模型服务' : 'Model services'}</span>
          <button type="button" className={styles.secondaryButton} onClick={onAdd}>
            {zh ? '+ 添加' : '+ Add'}
          </button>
        </div>
      ) : null}

      <section className={styles.group}>
        {variant === 'android' ? (
          <div className={styles.sectionLabel}>{zh ? '服务商' : 'Providers'}</div>
        ) : null}
        <div className={styles.listCard}>
          {providers.map((provider) => {
            const hasKey = provider.builtin
              ? Boolean(officialApiKey?.trim())
              : Boolean(provider.apiKey.trim())
            const enabledCount = provider.models.filter((item) => item.enabled).length
            const secondaryText = provider.builtin
              ? zh
                ? '使用当前 DeepSeek API Key'
                : 'Uses current DeepSeek API Key'
              : provider.baseUrl || (zh ? '未配置接口地址' : 'No base URL')
            const statusText = !provider.enabled
              ? zh
                ? '已停用'
                : 'Disabled'
              : enabledCount > 0
                ? zh
                  ? `已启用 · ${enabledCount}`
                  : `${enabledCount} active`
                : zh
                  ? '已启用'
                  : 'Enabled'

            return (
              <button
                key={provider.id}
                type="button"
                className={styles.providerRowBtn}
                onClick={() => onSelectProvider(provider.id)}
              >
                <span
                  className={clsx(styles.statusDot, hasKey && styles.statusDotReady)}
                  aria-hidden="true"
                />
                <span className={styles.providerMeta}>
                  <span className={styles.providerName}>{provider.name}</span>
                  <span className={styles.providerSub}>{secondaryText}</span>
                </span>
                <span className={styles.rowValueGroup}>
                  <span className={styles.rowValue}>{statusText}</span>
                  <span className={styles.rowChevron} aria-hidden="true">
                    <IconChevronRightOutline14 />
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      <section className={styles.group}>
        {variant === 'android' ? (
          <div className={styles.sectionLabel}>{zh ? '辅助设置' : 'Preferences'}</div>
        ) : null}
        <div className={styles.card}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>
              {zh ? '标题生成模型（可选）' : 'Title generation model (optional)'}
            </span>
            <input
              className={styles.input}
              value={titleDraft}
              placeholder={
                zh
                  ? variant === 'android'
                    ? '输入模型 ID，如 deepseek-flash'
                    : '留空默认跟随当前对话模型'
                  : 'Follow current chat model if blank'
              }
              autoCapitalize="off"
              spellCheck={false}
              onChange={(event) => {
                const value = event.target.value
                setTitleDraft(value)
                setTitleModel(value)
              }}
            />
          </label>
        </div>
        <p className={styles.caption}>
          {zh
            ? '留空时默认使用当前对话模型自动生成会话标题。'
            : 'Leaves blank to follow the active chat model when generating titles.'}
        </p>
      </section>
    </div>
  )
}

export const ModelProviderAddView = ({
  variant,
  formId = 'model-provider-add-form',
  onPickFormat,
  onBack,
  onSaved,
}: {
  variant: 'web' | 'android'
  formId?: string
  onPickFormat?: (current: ChatApiFormat, onConfirm: (next: ChatApiFormat) => void) => void
  onBack?: () => void
  onSaved: (createdProviderId: string) => void
}) => {
  const zh = useIsZh()
  const [name, setName] = useState('')
  const [format, setFormat] = useState<ChatApiFormat>('chat')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError(zh ? '请填写服务名称' : 'Enter a provider name')
      return
    }
    if (!normalizeProviderBaseUrl(baseUrl)) {
      setError(zh ? '请填写有效的 http(s) 接口地址' : 'Enter a valid http(s) base URL')
      return
    }
    const created = addCustomProvider({ name, format, baseUrl, apiKey })
    if (!created) {
      setError(zh ? '无法保存该服务配置' : 'Unable to save provider')
      return
    }
    onSaved(created.id)
  }

  return (
    <form
      id={formId}
      className={clsx(styles.container, variant === 'android' && styles.androidContainer)}
      onSubmit={handleSubmit}
    >
      {variant === 'web' ? (
        <div className={styles.topBar}>
          {onBack ? (
            <button type="button" className={styles.backButton} onClick={onBack}>
              <IconChevronRightOutline14 />
              {zh ? '返回' : 'Back'}
            </button>
          ) : null}
          <span className={styles.pageTitle}>{zh ? '添加服务商' : 'Add provider'}</span>
        </div>
      ) : null}

      <div className={styles.card}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{zh ? '名称' : 'Name'}</span>
          <input
            className={styles.input}
            value={name}
            placeholder={zh ? '如 OpenAI Compatible' : 'Provider name'}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
          />
        </label>

        {variant !== 'android' || !onPickFormat ? (
          <label className={styles.field}>
            <span className={styles.fieldLabel}>{zh ? '协议格式' : 'Protocol'}</span>
            <Select
              className={styles.formatSelect}
              ariaLabel={zh ? '协议格式' : 'Protocol'}
              value={format}
              options={FORMAT_OPTIONS}
              onChange={(value) => {
                setFormat(value)
                setError('')
              }}
            />
          </label>
        ) : null}

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{zh ? '接口地址' : 'Base URL'}</span>
          <input
            className={styles.input}
            type="url"
            inputMode="url"
            autoCapitalize="off"
            spellCheck={false}
            value={baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => {
              setBaseUrl(event.target.value)
              setError('')
            }}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>API Key</span>
          <input
            className={styles.input}
            type="password"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={apiKey}
            placeholder="sk-..."
            onChange={(event) => {
              setApiKey(event.target.value)
              setError('')
            }}
          />
        </label>

        {variant === 'web' && error ? (
          <div className={styles.feedbackError} role="alert">
            {error}
          </div>
        ) : null}

        {variant === 'web' ? (
          <div className={styles.actionsRow}>
            <button type="submit" className={styles.primaryButton}>
              {zh ? '保存' : 'Save'}
            </button>
          </div>
        ) : null}
      </div>

      {variant === 'android' && onPickFormat ? (
        <div className={styles.listCard}>
          <button
            type="button"
            className={styles.choiceRow}
            onClick={() =>
              onPickFormat(format, (value) => {
                setFormat(value)
                setError('')
              })
            }
          >
            <span className={styles.rowLabel}>{zh ? '协议格式' : 'Protocol'}</span>
            <span className={styles.rowValueGroup}>
              <span className={styles.rowValue}>{CHAT_API_FORMATS[format]}</span>
              <span className={styles.rowChevron} aria-hidden="true">
                <IconChevronRightOutline14 />
              </span>
            </span>
          </button>
        </div>
      ) : null}

      {variant === 'android' && error ? (
        <div className={clsx(styles.feedbackError, styles.androidFeedback)} role="alert">
          {error}
        </div>
      ) : null}
    </form>
  )
}

export const ModelProviderDetailView = ({
  variant,
  providerId,
  onPickFormat,
  onBack,
  onManageModels,
  onDeleted,
}: {
  variant: 'web' | 'android'
  providerId: string
  onPickFormat?: (current: ChatApiFormat, onConfirm: (next: ChatApiFormat) => void) => void
  onBack?: () => void
  onManageModels: () => void
  onDeleted: () => void
}) => {
  const zh = useIsZh()
  const provider = useModelProviders((state) =>
    state.providers.find((item) => item.id === providerId)
  )
  const officialApiKey = useSettings((state) => state.apiKey)
  const [apiKeyInput, setApiKeyInput] = useState(provider?.apiKey ?? '')
  const [baseUrlInput, setBaseUrlInput] = useState(provider?.baseUrl ?? '')
  const [urlError, setUrlError] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    setApiKeyInput(provider?.apiKey ?? '')
    setBaseUrlInput(provider?.baseUrl ?? '')
    setUrlError('')
    setTestResult(null)
  }, [provider?.id, provider?.apiKey, provider?.baseUrl])

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  if (!provider) {
    return null
  }

  const enabledModels = provider.models.filter((item) => item.enabled)

  const handleTest = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testProviderConnection(
        {
          builtin: provider.builtin,
          format: provider.format,
          baseUrl: provider.builtin ? '' : baseUrlInput,
          apiKey: provider.builtin ? '' : apiKeyInput,
        },
        {
          officialApiKey,
          signal: controller.signal,
        }
      )
      if (controller.signal.aborted) {
        return
      }
      if (result.ok) {
        setTestResult({
          ok: true,
          text:
            result.modelCount !== undefined && result.modelCount > 0
              ? zh
                ? `连接正常（检测到 ${result.modelCount} 个模型）`
                : `Connected (${result.modelCount} models)`
              : zh
                ? '连接正常'
                : 'Connected',
        })
      } else {
        setTestResult({ ok: false, text: result.error })
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setTestResult({
          ok: false,
          text: error instanceof Error ? error.message : zh ? '检测失败' : 'Check failed',
        })
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      setTesting(false)
    }
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.topBar}>
          {onBack ? (
            <button type="button" className={styles.backButton} onClick={onBack}>
              <IconChevronRightOutline14 />
              {zh ? '返回' : 'Back'}
            </button>
          ) : null}
          <span className={styles.pageTitle}>{provider.name}</span>
          <button
            type="button"
            className={styles.switch}
            role="switch"
            aria-label={provider.name}
            aria-checked={provider.enabled}
            onClick={() => setProviderEnabled(provider.id, !provider.enabled)}
          >
            <span />
          </button>
        </div>
      ) : null}

      <section className={styles.group}>
        <div className={styles.listCard}>
          {variant === 'android' ? (
            <div className={styles.switchRow}>
              <span className={styles.rowLabel}>{zh ? '启用此服务' : 'Enable provider'}</span>
              <button
                type="button"
                className={styles.switch}
                role="switch"
                aria-label={provider.name}
                aria-checked={provider.enabled}
                onClick={() => setProviderEnabled(provider.id, !provider.enabled)}
              >
                <span />
              </button>
            </div>
          ) : null}

          {variant === 'android' && onPickFormat ? (
            <button
              type="button"
              className={styles.choiceRow}
              onClick={() =>
                onPickFormat(provider.format, (value) =>
                  updateProvider(provider.id, { format: value })
                )
              }
            >
              <span className={styles.rowLabel}>{zh ? '协议格式' : 'Protocol'}</span>
              <span className={styles.rowValueGroup}>
                <span className={styles.rowValue}>{CHAT_API_FORMATS[provider.format]}</span>
                <span className={styles.rowChevron} aria-hidden="true">
                  <IconChevronRightOutline14 />
                </span>
              </span>
            </button>
          ) : (
            <div className={styles.selectRow}>
              <span className={styles.rowLabel}>{zh ? '协议格式' : 'Protocol'}</span>
              <Select
                className={styles.formatSelect}
                ariaLabel={zh ? '协议格式' : 'Protocol'}
                value={provider.format}
                options={FORMAT_OPTIONS}
                onChange={(value) => updateProvider(provider.id, { format: value })}
              />
            </div>
          )}

          {provider.builtin ? (
            <div className={styles.builtinTestRow}>
              <div className={styles.providerMeta}>
                <span className={styles.rowLabel}>API Key</span>
                <span className={styles.providerSub}>
                  {zh ? '使用当前 DeepSeek API Key' : 'Uses current DeepSeek API Key'}
                </span>
              </div>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={testing}
                onClick={() => void handleTest()}
              >
                {testing ? (zh ? '检测中…' : 'Testing…') : zh ? '检测' : 'Test'}
              </button>
            </div>
          ) : null}
        </div>
        {provider.builtin && testResult ? (
          <div
            className={clsx(
              testResult.ok ? styles.feedbackOk : styles.feedbackError,
              variant === 'android' && styles.androidFeedback
            )}
            role={testResult.ok ? 'status' : 'alert'}
          >
            {testResult.text}
          </div>
        ) : null}
      </section>

      {!provider.builtin ? (
        <section className={styles.group}>
          {variant === 'android' ? (
            <div className={styles.sectionLabel}>{zh ? '连接配置' : 'Connection'}</div>
          ) : null}
          <div className={styles.card}>
            <div className={styles.field}>
              <span className={styles.fieldLabel}>API Key</span>
              <div className={styles.inputRow}>
                <input
                  className={styles.input}
                  type="password"
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  value={apiKeyInput}
                  placeholder="sk-..."
                  onChange={(event) => {
                    const value = event.target.value
                    setApiKeyInput(value)
                    setTestResult(null)
                    updateProvider(provider.id, { apiKey: value })
                  }}
                />
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={testing}
                  onClick={() => void handleTest()}
                >
                  {testing ? (zh ? '检测中…' : 'Testing…') : zh ? '检测' : 'Test'}
                </button>
              </div>
            </div>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>{zh ? '接口地址' : 'Base URL'}</span>
              <input
                className={styles.input}
                type="url"
                inputMode="url"
                autoCapitalize="off"
                spellCheck={false}
                value={baseUrlInput}
                onChange={(event) => {
                  const value = event.target.value
                  setBaseUrlInput(value)
                  setUrlError('')
                  setTestResult(null)
                  const normalized = normalizeProviderBaseUrl(value)
                  if (normalized) {
                    updateProvider(provider.id, { baseUrl: normalized })
                  }
                }}
                onBlur={() => {
                  const normalized = normalizeProviderBaseUrl(baseUrlInput)
                  if (!normalized) {
                    setUrlError(zh ? '接口地址格式无效' : 'Invalid base URL')
                  } else {
                    setBaseUrlInput(normalized)
                    updateProvider(provider.id, { baseUrl: normalized })
                  }
                }}
              />
            </label>

            {urlError ? (
              <div className={styles.feedbackError} role="alert">
                {urlError}
              </div>
            ) : null}
            {testResult ? (
              <div
                className={testResult.ok ? styles.feedbackOk : styles.feedbackError}
                role={testResult.ok ? 'status' : 'alert'}
              >
                {testResult.text}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <section className={styles.group}>
        <div className={styles.sectionHeaderRow}>
          <span className={styles.sectionLabelInline}>
            {zh
              ? `已启用模型（${enabledModels.length}）`
              : `Enabled models (${enabledModels.length})`}
          </span>
          <button type="button" className={styles.linkButton} onClick={onManageModels}>
            {zh ? '+ 管理' : '+ Manage'}
          </button>
        </div>
        <div className={styles.listCard}>
          {enabledModels.length === 0 ? (
            <div className={styles.emptyNotice}>
              {zh ? '尚未启用模型，点下方「管理模型」拉取或手动添加' : 'No models enabled yet'}
            </div>
          ) : (
            enabledModels.map((model) => (
              <div key={model.id} className={styles.modelItem}>
                <div className={styles.modelItemText}>
                  <span className={styles.modelItemName}>{model.label || model.id}</span>
                  <span className={styles.modelItemId}>{model.id}</span>
                </div>
                <button
                  type="button"
                  className={styles.circleBtn}
                  aria-label={zh ? `移除 ${model.id}` : `Remove ${model.id}`}
                  onClick={() => toggleProviderModel(provider.id, model.id, false)}
                >
                  −
                </button>
              </div>
            ))
          )}
          <button type="button" className={styles.navRow} onClick={onManageModels}>
            <span className={styles.navRowLabel}>{zh ? '管理模型' : 'Manage models'}</span>
            <span className={styles.rowChevron} aria-hidden="true">
              <IconChevronRightOutline14 />
            </span>
          </button>
        </div>
      </section>

      {!provider.builtin ? (
        <button
          type="button"
          className={styles.dangerButton}
          onClick={() => {
            if (removeCustomProvider(provider.id)) {
              onDeleted()
            }
          }}
        >
          {zh ? '删除此服务' : 'Delete provider'}
        </button>
      ) : null}
    </div>
  )
}

export const ModelManageView = ({
  variant,
  providerId,
  onBack,
}: {
  variant: 'web' | 'android'
  providerId: string
  onBack?: () => void
}) => {
  const zh = useIsZh()
  const provider = useModelProviders((state) =>
    state.providers.find((item) => item.id === providerId)
  )
  const officialApiKey = useSettings((state) => state.apiKey)
  const [query, setQuery] = useState('')
  const [fetching, setFetching] = useState(false)
  const [fetchError, setFetchError] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [manualId, setManualId] = useState('')
  const [manualLabel, setManualLabel] = useState('')
  const [manualWindow, setManualWindow] = useState('')
  const [manualError, setManualError] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  useEffect(
    () => () => {
      abortRef.current?.abort()
    },
    []
  )

  if (!provider) {
    return null
  }

  const handleFetch = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setFetching(true)
    setFetchError('')
    try {
      if (provider.builtin) {
        const result = await fetchProviderModels(
          {
            baseUrl: typeof __API_ORIGIN__ === 'string' ? __API_ORIGIN__ : 'https://api.deepseek.com',
            format: 'chat',
            apiKey: officialApiKey ?? '',
          },
          { signal: controller.signal }
        )
        if (controller.signal.aborted) {
          return
        }
        if (result.ok) {
          mergeProviderModels(provider.id, result.models)
        } else {
          setFetchError(result.error)
        }
        return
      }
      const result = await fetchProviderModels(provider, { signal: controller.signal })
      if (controller.signal.aborted) {
        return
      }
      if (result.ok) {
        mergeProviderModels(provider.id, result.models)
      } else {
        setFetchError(result.error)
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setFetchError(error instanceof Error ? error.message : zh ? '拉取失败' : 'Fetch failed')
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null
      }
      setFetching(false)
    }
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filteredModels = provider.models.filter((item) => {
    if (!normalizedQuery) {
      return true
    }
    return (
      item.id.toLowerCase().includes(normalizedQuery) ||
      item.label.toLowerCase().includes(normalizedQuery) ||
      item.group.toLowerCase().includes(normalizedQuery)
    )
  })

  const grouped = new Map<string, typeof filteredModels>()
  for (const model of filteredModels) {
    const groupName = model.group || '其他'
    const list = grouped.get(groupName)
    if (list) {
      list.push(model)
    } else {
      grouped.set(groupName, [model])
    }
  }

  const handleManualSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!manualId.trim()) {
      setManualError(zh ? '请填写模型 ID' : 'Enter a model ID')
      return
    }
    const parsedWindow = manualWindow.trim() ? Number(manualWindow.trim()) : undefined
    if (
      parsedWindow !== undefined &&
      (!Number.isSafeInteger(parsedWindow) || parsedWindow < 1024)
    ) {
      setManualError(zh ? '上下文窗口须为不小于 1024 的整数' : 'Context window must be >= 1024')
      return
    }
    if (
      addManualModel(provider.id, {
        id: manualId,
        label: manualLabel,
        contextWindow: parsedWindow,
      })
    ) {
      setManualId('')
      setManualLabel('')
      setManualWindow('')
      setManualError('')
      setManualOpen(false)
    }
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.topBar}>
          {onBack ? (
            <button type="button" className={styles.backButton} onClick={onBack}>
              <IconChevronRightOutline14 />
              {zh ? '返回' : 'Back'}
            </button>
          ) : null}
          <span className={styles.pageTitle}>{zh ? `管理模型 · ${provider.name}` : provider.name}</span>
        </div>
      ) : null}

      <div className={styles.searchBar}>
        <div className={styles.searchInputWrap}>
          <span className={styles.searchIcon} aria-hidden="true">
            <IconSearchOutline16 />
          </span>
          <input
            type="search"
            className={styles.searchInput}
            placeholder={zh ? '搜索模型名称或 ID' : 'Search model name or ID'}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => {
            if (fetching) {
              abortRef.current?.abort()
            } else {
              void handleFetch()
            }
          }}
        >
          {fetching ? (zh ? '取消' : 'Cancel') : zh ? '拉取' : 'Fetch'}
        </button>
      </div>

      {fetchError ? (
        <div className={styles.feedbackError} role="alert">
          {fetchError}
        </div>
      ) : null}

      {grouped.size === 0 ? (
        <div className={styles.listCard}>
          <div className={styles.emptyNotice}>
            {provider.models.length === 0
              ? zh
                ? '点击右上「拉取」获取可用模型，或手动添加模型 ID'
                : 'Fetch models or add a model ID manually'
              : zh
                ? '没有匹配的模型'
                : 'No matching models'}
          </div>
        </div>
      ) : (
        Array.from(grouped.entries()).map(([groupName, items]) => (
          <div key={groupName} className={styles.groupSection}>
            <div className={styles.groupLabel}>{groupName}</div>
            <div className={styles.listCard}>
              {items.map((model) => (
                <div key={model.id} className={styles.modelItem}>
                  <div className={styles.modelItemText}>
                    <span className={styles.modelItemName}>{model.label || model.id}</span>
                    <span className={styles.modelItemId}>{model.id}</span>
                  </div>
                  <button
                    type="button"
                    className={clsx(styles.circleBtn, model.enabled && styles.circleBtnActive)}
                    aria-label={
                      model.enabled
                        ? zh
                          ? `停用 ${model.id}`
                          : `Disable ${model.id}`
                        : zh
                          ? `启用 ${model.id}`
                          : `Enable ${model.id}`
                    }
                    aria-pressed={model.enabled}
                    onClick={() => toggleProviderModel(provider.id, model.id)}
                  >
                    {model.enabled ? <IconCheckOutline16 /> : '+'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))
      )}

      <button
        type="button"
        className={styles.manualAddBtn}
        onClick={() => {
          setManualError('')
          setManualOpen(true)
        }}
      >
        {zh ? '+ 手动添加模型 ID' : '+ Add model ID manually'}
      </button>

      {manualOpen ? (
        <Modal
          title={zh ? '手动添加模型 ID' : 'Add model ID'}
          closable
          className={styles.modalDialog}
          onClose={() => setManualOpen(false)}
        >
          <form
            className={clsx(styles.container, variant === 'android' && styles.modalAndroid)}
            onSubmit={handleManualSubmit}
          >
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{zh ? '模型 ID' : 'Model ID'}</span>
              <input
                className={styles.input}
                autoFocus
                autoCapitalize="off"
                spellCheck={false}
                value={manualId}
                placeholder="claude-sonnet-4-5"
                onChange={(event) => {
                  setManualId(event.target.value)
                  setManualError('')
                }}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{zh ? '展示名（可选）' : 'Display name (optional)'}</span>
              <input
                className={styles.input}
                value={manualLabel}
                placeholder={zh ? '留空使用模型 ID' : 'Defaults to model ID'}
                onChange={(event) => setManualLabel(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>
                {zh ? '上下文窗口 token（可选）' : 'Context window tokens (optional)'}
              </span>
              <input
                className={styles.input}
                type="number"
                min={1024}
                step={1024}
                value={manualWindow}
                placeholder={zh ? '留空沿用默认估算' : 'Use default estimate if blank'}
                onChange={(event) => {
                  setManualWindow(event.target.value)
                  setManualError('')
                }}
              />
            </label>
            {manualError ? (
              <div className={styles.feedbackError} role="alert">
                {manualError}
              </div>
            ) : null}
            <div className={styles.actionsRow}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => setManualOpen(false)}
              >
                {zh ? '取消' : 'Cancel'}
              </button>
              <button type="submit" className={styles.primaryButton}>
                {zh ? '添加并启用' : 'Add & enable'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}
    </div>
  )
}

export const ModelServicesSettings = () => {
  const [subpage, setSubpage] = useState<'list' | 'add' | 'detail' | 'manage'>('list')
  const [selectedId, setSelectedId] = useState<string>('deepseek')

  if (subpage === 'add') {
    return (
      <ModelProviderAddView
        variant="web"
        onBack={() => setSubpage('list')}
        onSaved={(id) => {
          setSelectedId(id)
          setSubpage('detail')
        }}
      />
    )
  }
  if (subpage === 'detail') {
    return (
      <ModelProviderDetailView
        variant="web"
        providerId={selectedId}
        onBack={() => setSubpage('list')}
        onManageModels={() => setSubpage('manage')}
        onDeleted={() => setSubpage('list')}
      />
    )
  }
  if (subpage === 'manage') {
    return (
      <ModelManageView
        variant="web"
        providerId={selectedId}
        onBack={() => setSubpage('detail')}
      />
    )
  }
  return (
    <ModelProviderListView
      variant="web"
      onAdd={() => setSubpage('add')}
      onSelectProvider={(id) => {
        setSelectedId(id)
        setSubpage('detail')
      }}
    />
  )
}

export const ModelServicesDialog = ({ onClose }: { onClose: () => void }) => {
  const zh = useIsZh()
  return (
    <Modal
      title={zh ? '模型服务' : 'Model services'}
      closable
      className={styles.servicesDialog}
      onClose={onClose}
    >
      <ModelServicesSettings />
    </Modal>
  )
}
