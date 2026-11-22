import clsx from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { IconChevronRightOutline14 } from '../../components/base/icons.js'
import { Select } from '../../components/base/Select.js'
import { useSettings } from '../../services/settings.js'
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

export const SearchToolsSettings = ({
  variant,
  onSelectWebFetchMode,
}: {
  variant: 'web' | 'android'
  onSelectWebFetchMode?: () => void
}) => {
  const zh = useIsZh()
  const officialApiKey = useSettings((state) => state.apiKey)
  const { engine, apiKeys, searxngUrl, webFetchMode, useExternalOnOfficial } =
    useSearchToolsConfig()
  const [testStatus, setTestStatus] = useState<TestStatus>({ kind: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  const cancelTest = () => {
    abortRef.current?.abort()
    abortRef.current = null
  }

  useEffect(() => cancelTest, [])

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
    </div>
  )
}
