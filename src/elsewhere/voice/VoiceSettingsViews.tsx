import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { android, listAndroidSystemVoices } from '../../app/android.js'
import { IconChevronRightOutline14, IconSearchOutline16 } from '../../components/base/icons.js'
import { showToast } from '../../components/base/toastState.js'
import { describeReadAloudError } from '../../services/speech/readAloud.js'
import { setTtsVoice, useSettings } from '../../services/settings.js'
import type { ModelProviderConfig } from '../models/types.js'
import { useIsZh } from '../text.js'
import {
  applyOpenAiAsrPreset,
  applyOpenAiTtsPreset,
  getImportableModelProviders,
  importModelProviderForAsr,
  importModelProviderForTts,
  isOpenRouterUrl,
  OPENAI_ASR_PRESETS,
  OPENAI_TTS_PRESETS,
  setAsrApiKey,
  setAsrProvider,
  setEdgeSpeed,
  setEdgeVoiceId,
  setSystemAsrLanguage,
  setSystemTtsSpeed,
  setSystemTtsVoiceId,
  setTtsApiKey,
  setTtsProvider,
  SILICONFLOW_COSYVOICE_VOICES,
  updateOpenAiAsr,
  updateOpenAiTts,
  useVoiceConfig,
} from './config.js'
import {
  filterVoices,
  formatSystemVoiceItem,
  getEdgeVoiceById,
  localizeEdgeVoices,
  refreshEdgeVoicesList,
  useEdgeVoicesStore,
} from './edgeVoices.js'
import {
  fetchOpenRouterSpeechVoices,
  getSamplePreviewText,
  stopVoicePreview,
  toggleVoicePreview,
  useVoicePreview,
} from './tts.js'
import type {
  AsrLanguage,
  AsrProviderId,
  OpenAiAsrPresetId,
  OpenAiTtsPresetId,
  SystemVoiceItem,
  TtsProviderId,
  VoiceLangFilter,
} from './types.js'
import styles from './VoiceSettingsViews.module.css'

const SpeakerIcon = ({ active }: { active: boolean }) =>
  active ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  ) : (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    </svg>
  )

const SpeedTicks = ({
  min,
  max,
  ticks,
}: {
  min: number
  max: number
  ticks: readonly number[]
}) => (
  <div className={styles.sliderTicks}>
    {ticks.map((tick, index) => {
      const isStart = index === 0
      const isEnd = index === ticks.length - 1
      const ratio = (tick - min) / (max - min)
      return (
        <span
          key={tick}
          className={clsx(
            styles.sliderTick,
            isStart ? styles.sliderTickStart : isEnd ? styles.sliderTickEnd : styles.sliderTickMid
          )}
          style={isStart || isEnd ? undefined : { left: `calc(8px + (100% - 16px) * ${ratio})` }}
        >
          {tick.toFixed(1)}x
        </span>
      )
    })}
  </div>
)

export const RefreshVoicesIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
    <path d="M16 16h5v5" />
  </svg>
)

const ImportProviderSheet = ({
  open,
  providers,
  zh,
  onSelect,
  onClose,
}: {
  open: boolean
  providers: readonly ModelProviderConfig[]
  zh: boolean
  onSelect: (provider: ModelProviderConfig) => void
  onClose: () => void
}) => {
  if (!open) {
    return null
  }
  return (
    <div
      className={styles.sheetOverlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true">
        <div className={styles.sheetHandle} />
        <div className={styles.sheetHeader}>
          <span className={styles.sheetTitle}>
            {zh ? '选择已配置的模型服务' : 'Import from model service'}
          </span>
          <button type="button" className={styles.linkBtn} onClick={onClose}>
            {zh ? '取消' : 'Cancel'}
          </button>
        </div>
        <div className={styles.sheetList}>
          {providers.length === 0 ? (
            <div className={styles.emptyState}>
              {zh ? '暂无可导入的第三方模型服务' : 'No configured third-party model services'}
            </div>
          ) : (
            providers.map((provider) => (
              <button
                key={provider.id}
                type="button"
                className={styles.sheetItem}
                onClick={() => onSelect(provider)}
              >
                <div className={styles.sheetItemName}>{provider.name}</div>
                <div className={styles.sheetItemSub}>{provider.baseUrl}</div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

const OpenRouterVoiceSheet = ({
  open,
  voices,
  currentVoice,
  zh,
  onSelect,
  onClose,
}: {
  open: boolean
  voices: readonly string[]
  currentVoice: string
  zh: boolean
  onSelect: (voice: string) => void
  onClose: () => void
}) => {
  const [query, setQuery] = useState('')
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? voices.filter((v) => v.toLowerCase().includes(q)) : voices
  }, [query, voices])

  if (!open) {
    return null
  }
  return (
    <div
      className={styles.sheetOverlay}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className={styles.sheet} role="dialog" aria-modal="true">
        <div className={styles.sheetHandle} />
        <div className={styles.sheetHeader}>
          <span className={styles.sheetTitle}>{zh ? '选择音色' : 'Select voice'}</span>
          <button type="button" className={styles.linkBtn} onClick={onClose}>
            {zh ? '关闭' : 'Close'}
          </button>
        </div>
        <div className={styles.searchBox}>
          <IconSearchOutline16 />
          <input
            type="text"
            className={styles.searchInput}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={zh ? '筛选音色名称' : 'Filter voice name'}
          />
        </div>
        <div className={styles.sheetList}>
          {filtered.length === 0 ? (
            <div className={styles.emptyState}>{zh ? '未找到匹配音色' : 'No matching voices'}</div>
          ) : (
            filtered.map((voice) => {
              const selected = voice === currentVoice
              return (
                <button
                  key={voice}
                  type="button"
                  className={clsx(styles.sheetItem, selected && styles.voiceRowSelected)}
                  onClick={() => onSelect(voice)}
                >
                  <div className={styles.cardHeaderRow}>
                    <span className={styles.sheetItemName}>{voice}</span>
                    {selected ? <span className={styles.checkMark}>✓</span> : null}
                  </div>
                </button>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}

export const getTtsSummaryText = (
  zh: boolean,
  edgeVoices: readonly { id: string; name: string }[]
): string => {
  const config = useVoiceConfig.getState().config
  const dsVoice = useSettings.getState().ttsVoice
  switch (config.ttsProvider) {
    case 'edge': {
      const voice = getEdgeVoiceById(config.edgeVoiceId, edgeVoices as never, zh)
      return `Edge ${voice.name}`
    }
    case 'deepseek':
      return dsVoice === 'tide'
        ? zh
          ? 'DeepSeek 暗潮'
          : 'DeepSeek Tide'
        : zh
          ? 'DeepSeek 海星'
          : 'DeepSeek Stella'
    case 'system':
      return zh ? '系统语音' : 'System'
    case 'openai': {
      const preset = OPENAI_TTS_PRESETS[config.openaiTts.presetId]
      return config.openaiTts.presetId === 'custom'
        ? zh
          ? 'OpenAI 兼容'
          : 'OpenAI-compatible'
        : zh
          ? preset.label
          : preset.labelEn
    }
  }
}

export const VoiceTtsView = ({
  variant,
  onOpenVoicePicker,
}: {
  variant: 'android' | 'web'
  onOpenVoicePicker: (mode: 'edge' | 'system') => void
}) => {
  const zh = useIsZh()
  const config = useVoiceConfig((state) => state.config)
  const secrets = useVoiceConfig((state) => state.secrets)
  const dsVoice = useSettings((state) => state.ttsVoice)
  const edgeVoices = useEdgeVoicesStore((state) => state.voices)
  const playingId = useVoicePreview((state) => state.playingId)
  const [importOpen, setImportOpen] = useState(false)
  const [fetchingOrVoices, setFetchingOrVoices] = useState(false)
  const [orVoices, setOrVoices] = useState<string[]>([])
  const [orSheetOpen, setOrSheetOpen] = useState(false)

  const showEdge = Boolean(android)
  const providerOptions: { id: TtsProviderId; label: string }[] = showEdge
    ? [
        { id: 'edge', label: zh ? 'Edge 语音' : 'Edge Voice' },
        { id: 'deepseek', label: 'DeepSeek' },
        { id: 'openai', label: zh ? 'OpenAI 兼容' : 'OpenAI-compatible' },
        { id: 'system', label: zh ? '系统语音' : 'System' },
      ]
    : [
        { id: 'deepseek', label: 'DeepSeek' },
        { id: 'openai', label: zh ? 'OpenAI 兼容' : 'OpenAI-compatible' },
        { id: 'system', label: zh ? '系统语音' : 'System' },
      ]

  const currentEdgeVoice = getEdgeVoiceById(config.edgeVoiceId, edgeVoices, zh)
  const importableProviders = useMemo(() => getImportableModelProviders(), [])
  const openRouterMode = isOpenRouterUrl(config.openaiTts.baseUrl)

  const handlePreview = (previewId: string, text: string) => {
    toggleVoicePreview(previewId, { text }, (error) => {
      const msg = describeReadAloudError(error)
      showToast(typeof msg === 'string' ? msg : msg)
    })
  }

  const handleFetchOpenRouterVoices = async () => {
    if (fetchingOrVoices) {
      return
    }
    setFetchingOrVoices(true)
    try {
      const list = await fetchOpenRouterSpeechVoices(
        config.openaiTts.baseUrl,
        secrets.ttsApiKey,
        config.openaiTts.model
      )
      if (list.length === 0) {
        showToast(zh ? '该模型未返回可选音色' : 'No voices returned for this model')
      } else {
        setOrVoices(list)
        setOrSheetOpen(true)
      }
    } catch (error) {
      const msg = describeReadAloudError(error)
      showToast(typeof msg === 'string' ? msg : msg)
    } finally {
      setFetchingOrVoices(false)
    }
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>{zh ? '朗读服务' : 'Read-aloud service'}</div>
        <div className={showEdge ? styles.grid2 : styles.grid3}>
          {providerOptions.map((item) => {
            const active = config.ttsProvider === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={clsx(styles.segmentBtn, active && styles.segmentBtnActive)}
                onClick={() => {
                  stopVoicePreview()
                  setTtsProvider(item.id)
                }}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      {config.ttsProvider === 'edge' && showEdge ? (
        <>
          <div className={styles.groupedCard}>
            <button
              type="button"
              className={styles.groupedRow}
              onClick={() => onOpenVoicePicker('edge')}
            >
              <span className={styles.cardTitle}>{zh ? '音色' : 'Voice'}</span>
              <span className={styles.rowValue}>
                <span className={styles.rowValueText}>
                  {currentEdgeVoice.name}（{currentEdgeVoice.meta}）
                </span>
                <IconChevronRightOutline14 />
              </span>
            </button>
            <div className={styles.groupedSection}>
              <div className={styles.speedHeader}>
                <span className={styles.cardTitle}>{zh ? '语速' : 'Speed'}</span>
                <span className={styles.speedValue}>{config.edgeSpeed.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.7}
                max={2.0}
                step={0.1}
                value={config.edgeSpeed}
                onChange={(event) => setEdgeSpeed(event.target.valueAsNumber)}
                className={styles.slider}
                aria-label={zh ? '语速' : 'Speed'}
              />
              <SpeedTicks min={0.7} max={2.0} ticks={[0.7, 1.0, 1.5, 2.0]} />
            </div>
          </div>
          <button
            type="button"
            className={clsx(
              styles.previewButton,
              playingId === 'tts-main' && styles.previewButtonPlaying
            )}
            onClick={() => handlePreview('tts-main', getSamplePreviewText(currentEdgeVoice.locale))}
          >
            <SpeakerIcon active={playingId === 'tts-main'} />
            <span>
              {playingId === 'tts-main'
                ? zh
                  ? '停止试听'
                  : 'Stop preview'
                : zh
                  ? '试听当前音色'
                  : 'Preview voice'}
            </span>
          </button>
        </>
      ) : null}

      {config.ttsProvider === 'deepseek' ? (
        <>
          <div className={styles.card}>
            <div className={styles.fieldLabel}>{zh ? '音色' : 'Voice'}</div>
            {(
              [
                ['stella', zh ? '海星' : 'Stella', zh ? '俏皮甜美' : 'Playful and sweet'],
                ['tide', zh ? '暗潮' : 'Tide', zh ? '低沉浑厚' : 'Deep and rich'],
              ] as const
            ).map(([id, name, desc]) => {
              const on = dsVoice === id
              return (
                <button
                  key={id}
                  type="button"
                  className={clsx(styles.radioCard, on && styles.radioCardActive)}
                  onClick={() => setTtsVoice(id)}
                >
                  <div>
                    <div className={styles.radioTitle}>{name}</div>
                    <div className={styles.radioDesc}>{desc}</div>
                  </div>
                  {on ? <span className={styles.checkMark}>✓</span> : null}
                </button>
              )
            })}
          </div>
          <button
            type="button"
            className={clsx(
              styles.previewButton,
              playingId === 'tts-main' && styles.previewButtonPlaying
            )}
            onClick={() => handlePreview('tts-main', getSamplePreviewText('zh-CN'))}
          >
            <SpeakerIcon active={playingId === 'tts-main'} />
            <span>
              {playingId === 'tts-main'
                ? zh
                  ? '停止试听'
                  : 'Stop preview'
                : zh
                  ? '试听当前音色'
                  : 'Preview voice'}
            </span>
          </button>
        </>
      ) : null}

      {config.ttsProvider === 'system' ? (
        <>
          <div className={styles.groupedCard}>
            <button
              type="button"
              className={styles.groupedRow}
              onClick={() => onOpenVoicePicker('system')}
            >
              <span className={styles.cardTitle}>{zh ? '系统音色' : 'System voice'}</span>
              <span className={styles.rowValue}>
                <span className={styles.rowValueText}>
                  {config.systemTts.voiceId || (zh ? '系统默认' : 'System default')}
                </span>
                <IconChevronRightOutline14 />
              </span>
            </button>
            <div className={styles.groupedSection}>
              <div className={styles.speedHeader}>
                <span className={styles.cardTitle}>{zh ? '语速' : 'Speed'}</span>
                <span className={styles.speedValue}>{config.systemTts.speed.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.7}
                max={2.0}
                step={0.1}
                value={config.systemTts.speed}
                onChange={(event) => setSystemTtsSpeed(event.target.valueAsNumber)}
                className={styles.slider}
                aria-label={zh ? '语速' : 'Speed'}
              />
              <SpeedTicks min={0.7} max={2.0} ticks={[0.7, 1.0, 1.5, 2.0]} />
            </div>
          </div>
          <button
            type="button"
            className={clsx(
              styles.previewButton,
              playingId === 'tts-main' && styles.previewButtonPlaying
            )}
            onClick={() => handlePreview('tts-main', getSamplePreviewText(zh ? 'zh-CN' : 'en-US'))}
          >
            <SpeakerIcon active={playingId === 'tts-main'} />
            <span>
              {playingId === 'tts-main'
                ? zh
                  ? '停止试听'
                  : 'Stop preview'
                : zh
                  ? '试听系统音色'
                  : 'Preview system voice'}
            </span>
          </button>
        </>
      ) : null}

      {config.ttsProvider === 'openai' ? (
        <>
          <div className={styles.card}>
            <div className={styles.cardHeaderRow}>
              <span className={styles.cardTitle}>{zh ? '快捷预设' : 'Presets'}</span>
              <button type="button" className={styles.linkBtn} onClick={() => setImportOpen(true)}>
                {zh ? '从模型服务导入' : 'Import from model service'}
              </button>
            </div>
            <div className={styles.chipWrap}>
              {(Object.keys(OPENAI_TTS_PRESETS) as OpenAiTtsPresetId[]).map((presetKey) => {
                const preset = OPENAI_TTS_PRESETS[presetKey]
                const on = config.openaiTts.presetId === presetKey
                return (
                  <button
                    key={presetKey}
                    type="button"
                    className={clsx(styles.chipBtn, on && styles.chipBtnActive)}
                    onClick={() => applyOpenAiTtsPreset(presetKey)}
                  >
                    {zh ? preset.label : preset.labelEn}
                  </button>
                )
              })}
            </div>
          </div>

          <div className={styles.card}>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>{zh ? '接口地址' : 'Base URL'}</label>
              <input
                type="url"
                className={styles.monoInput}
                value={config.openaiTts.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => updateOpenAiTts({ baseUrl: event.target.value })}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>API Key</label>
              <input
                type="password"
                className={styles.monoInput}
                value={secrets.ttsApiKey}
                placeholder="sk-..."
                autoComplete="off"
                onChange={(event) => setTtsApiKey(event.target.value)}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>{zh ? '模型' : 'Model'}</label>
              <input
                type="text"
                className={styles.monoInput}
                value={config.openaiTts.model}
                placeholder="tts-1"
                onChange={(event) => updateOpenAiTts({ model: event.target.value })}
              />
            </div>

            <div className={styles.fieldGroup}>
              <div className={styles.cardHeaderRow}>
                <label className={styles.fieldLabel}>{zh ? '音色' : 'Voice'}</label>
                {openRouterMode ? (
                  <button
                    type="button"
                    className={styles.linkBtn}
                    disabled={fetchingOrVoices}
                    onClick={() => void handleFetchOpenRouterVoices()}
                  >
                    {fetchingOrVoices
                      ? zh
                        ? '拉取中…'
                        : 'Loading…'
                      : zh
                        ? '拉取音色列表'
                        : 'Fetch voice list'}
                  </button>
                ) : null}
              </div>
              <input
                type="text"
                className={styles.monoInput}
                value={config.openaiTts.voice}
                placeholder="alloy"
                onChange={(event) => updateOpenAiTts({ voice: event.target.value })}
              />
              {config.openaiTts.presetId === 'siliconflow' ? (
                <div className={styles.chipWrap}>
                  {SILICONFLOW_COSYVOICE_VOICES.map((voiceName) => {
                    const modelPrefix =
                      config.openaiTts.model.trim() || 'FunAudioLLM/CosyVoice2-0.5B'
                    const fullVoice = `${modelPrefix}:${voiceName}`
                    const active =
                      config.openaiTts.voice === fullVoice || config.openaiTts.voice === voiceName
                    return (
                      <button
                        key={voiceName}
                        type="button"
                        className={clsx(styles.chipBtn, active && styles.chipBtnActive)}
                        onClick={() => updateOpenAiTts({ voice: fullVoice })}
                      >
                        {voiceName}
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>

            <div className={styles.fieldGroup}>
              <div className={styles.speedHeader}>
                <span className={styles.fieldLabel}>{zh ? '语速' : 'Speed'}</span>
                <span className={styles.speedValue}>{config.openaiTts.speed.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.1}
                value={config.openaiTts.speed}
                onChange={(event) => updateOpenAiTts({ speed: event.target.valueAsNumber })}
                className={styles.slider}
                aria-label={zh ? '语速' : 'Speed'}
              />
              <SpeedTicks min={0.5} max={2.0} ticks={[0.5, 1.0, 1.5, 2.0]} />
            </div>
          </div>

          <button
            type="button"
            className={clsx(
              styles.previewButton,
              playingId === 'tts-main' && styles.previewButtonPlaying
            )}
            onClick={() => handlePreview('tts-main', getSamplePreviewText(zh ? 'zh-CN' : 'en-US'))}
          >
            <SpeakerIcon active={playingId === 'tts-main'} />
            <span>
              {playingId === 'tts-main'
                ? zh
                  ? '停止试听'
                  : 'Stop preview'
                : zh
                  ? '试听当前配置'
                  : 'Preview configuration'}
            </span>
          </button>
        </>
      ) : null}

      <ImportProviderSheet
        open={importOpen}
        providers={importableProviders}
        zh={zh}
        onClose={() => setImportOpen(false)}
        onSelect={(provider) => {
          importModelProviderForTts(provider)
          setImportOpen(false)
          showToast(zh ? `已导入 ${provider.name}` : `Imported ${provider.name}`)
        }}
      />

      <OpenRouterVoiceSheet
        open={orSheetOpen}
        voices={orVoices}
        currentVoice={config.openaiTts.voice}
        zh={zh}
        onClose={() => setOrSheetOpen(false)}
        onSelect={(voice) => {
          updateOpenAiTts({ voice })
          setOrSheetOpen(false)
        }}
      />
    </div>
  )
}

export const VoicePickerView = ({
  variant,
  mode,
  refreshNonce,
  onBack,
}: {
  variant: 'android' | 'web'
  mode: 'edge' | 'system'
  refreshNonce?: number
  onBack?: () => void
}) => {
  const zh = useIsZh()
  const config = useVoiceConfig((state) => state.config)
  const edgeVoices = useEdgeVoicesStore((state) => state.voices)
  const edgeLoading = useEdgeVoicesStore((state) => state.loading)
  const playingId = useVoicePreview((state) => state.playingId)

  const [query, setQuery] = useState('')
  const [langFilter, setLangFilter] = useState<VoiceLangFilter>('all')
  const [systemVoices, setSystemVoices] = useState<SystemVoiceItem[]>([])
  const [systemLoading, setSystemLoading] = useState(false)

  const loadSystemVoices = useCallback(async () => {
    setSystemLoading(true)
    try {
      if (android?.listSystemTtsVoices) {
        const raw = await listAndroidSystemVoices()
        const items = raw.map((item) => formatSystemVoiceItem(item, zh))
        items.sort((a, b) => a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name))
        setSystemVoices(items)
      } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        const raw = window.speechSynthesis.getVoices()
        const items = raw.map((item) =>
          formatSystemVoiceItem(
            { id: item.voiceURI || item.name, name: item.name, locale: item.lang },
            zh
          )
        )
        setSystemVoices(items)
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error))
    } finally {
      setSystemLoading(false)
    }
  }, [zh])

  const handleRefresh = useCallback(() => {
    if (mode === 'edge') {
      void refreshEdgeVoicesList().catch((error) => {
        showToast(error instanceof Error ? error.message : String(error))
      })
    } else {
      void loadSystemVoices()
    }
  }, [loadSystemVoices, mode])

  useEffect(() => {
    if (mode !== 'system') {
      return
    }
    if (android?.listSystemTtsVoices) {
      void loadSystemVoices()
      return
    }
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
      return
    }
    const synth = window.speechSynthesis
    let disposed = false
    const syncWebVoices = () => {
      if (disposed) {
        return false
      }
      const raw = synth.getVoices()
      if (raw.length === 0) {
        return false
      }
      const items = raw.map((item) =>
        formatSystemVoiceItem(
          { id: item.voiceURI || item.name, name: item.name, locale: item.lang },
          zh
        )
      )
      setSystemVoices(items)
      setSystemLoading(false)
      return true
    }
    const onVoicesChanged = () => {
      syncWebVoices()
    }
    setSystemLoading(true)
    synth.addEventListener?.('voiceschanged', onVoicesChanged)
    const timers: ReturnType<typeof setTimeout>[] = []
    if (!syncWebVoices()) {
      timers.push(
        setTimeout(() => {
          syncWebVoices()
        }, 250)
      )
      timers.push(
        setTimeout(() => {
          if (!syncWebVoices() && !disposed) {
            setSystemLoading(false)
          }
        }, 800)
      )
    }
    return () => {
      disposed = true
      synth.removeEventListener?.('voiceschanged', onVoicesChanged)
      for (const timer of timers) {
        clearTimeout(timer)
      }
    }
  }, [loadSystemVoices, mode, zh])

  useEffect(() => {
    if (refreshNonce && refreshNonce > 0) {
      handleRefresh()
    }
  }, [handleRefresh, refreshNonce])

  const localizedEdgeVoices = useMemo(() => localizeEdgeVoices(edgeVoices, zh), [edgeVoices, zh])
  const filteredEdge = useMemo(
    () => filterVoices(localizedEdgeVoices, langFilter, query),
    [localizedEdgeVoices, langFilter, query]
  )
  const filteredSystem = useMemo(
    () => filterVoices(systemVoices, langFilter, query),
    [systemVoices, langFilter, query]
  )

  const loading = mode === 'edge' ? edgeLoading : systemLoading
  const filters: { id: VoiceLangFilter; label: string }[] = [
    { id: 'all', label: zh ? '全部' : 'All' },
    { id: 'zh', label: zh ? '中文' : 'Chinese' },
    { id: 'en', label: zh ? '英语' : 'English' },
    { id: 'ja', label: zh ? '日语' : 'Japanese' },
  ]

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.topBar}>
          <div className={styles.topBarLeft}>
            {onBack ? (
              <button
                type="button"
                className={styles.backButton}
                aria-label={zh ? '返回' : 'Back'}
                onClick={onBack}
              >
                <IconChevronRightOutline14 />
              </button>
            ) : null}
            <span className={styles.pageTitle}>{zh ? '选择音色' : 'Select voice'}</span>
          </div>
          <button
            type="button"
            className={styles.iconActionBtn}
            disabled={loading}
            title={zh ? '刷新列表' : 'Refresh'}
            onClick={handleRefresh}
          >
            <RefreshVoicesIcon />
          </button>
        </div>
      ) : null}

      <div className={styles.searchBox}>
        <IconSearchOutline16 />
        <input
          type="text"
          className={styles.searchInput}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={zh ? '搜索音色名称或语种' : 'Search voice or language'}
        />
      </div>

      <div className={styles.filterRow}>
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            className={clsx(styles.filterPill, langFilter === item.id && styles.filterPillActive)}
            onClick={() => setLangFilter(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className={styles.groupedCard}>
        {loading ? (
          <div className={styles.emptyState}>{zh ? '正在同步音色列表…' : 'Loading voices…'}</div>
        ) : mode === 'edge' ? (
          filteredEdge.length === 0 ? (
            <div className={styles.emptyState}>{zh ? '未找到匹配音色' : 'No matching voices'}</div>
          ) : (
            filteredEdge.map((voice) => {
              const selected = config.edgeVoiceId === voice.id
              const playing = playingId === `pick:${voice.id}`
              return (
                <div
                  key={voice.id}
                  className={clsx(styles.voiceRow, selected && styles.voiceRowSelected)}
                >
                  <button
                    type="button"
                    className={styles.voiceSelectBtn}
                    onClick={() => setEdgeVoiceId(voice.id)}
                  >
                    <div className={styles.voiceName}>{voice.name}</div>
                    <div className={styles.voiceMeta}>{voice.meta}</div>
                  </button>
                  <div className={styles.voiceActions}>
                    <button
                      type="button"
                      className={clsx(
                        styles.inlineSpeakBtn,
                        playing && styles.inlineSpeakBtnPlaying
                      )}
                      aria-label={zh ? '试听' : 'Preview'}
                      onClick={() =>
                        toggleVoicePreview(
                          `pick:${voice.id}`,
                          {
                            text: getSamplePreviewText(voice.locale),
                            overrideConfig: {
                              provider: 'edge',
                              edgeVoiceId: voice.id,
                              edgeSpeed: config.edgeSpeed,
                            },
                          },
                          (error) => {
                            const msg = describeReadAloudError(error)
                            showToast(typeof msg === 'string' ? msg : msg)
                          }
                        )
                      }
                    >
                      <SpeakerIcon active={playing} />
                    </button>
                    <button
                      type="button"
                      className={clsx(styles.voiceSelectBtn, styles.checkCell)}
                      onClick={() => setEdgeVoiceId(voice.id)}
                      aria-label={voice.name}
                    >
                      {selected ? '✓' : ''}
                    </button>
                  </div>
                </div>
              )
            })
          )
        ) : (
          <>
            {!query.trim() && langFilter === 'all' ? (
              <div
                className={clsx(
                  styles.voiceRow,
                  config.systemTts.voiceId === '' && styles.voiceRowSelected
                )}
              >
                <button
                  type="button"
                  className={styles.voiceSelectBtn}
                  onClick={() => setSystemTtsVoiceId('')}
                >
                  <div className={styles.voiceName}>{zh ? '系统默认' : 'System default'}</div>
                  <div className={styles.voiceMeta}>
                    {zh ? '跟随当前系统语音引擎设置' : 'Follow system speech engine default'}
                  </div>
                </button>
                <div className={styles.voiceActions}>
                  <button
                    type="button"
                    className={clsx(
                      styles.inlineSpeakBtn,
                      playingId === 'pick:__default__' && styles.inlineSpeakBtnPlaying
                    )}
                    aria-label={zh ? '试听' : 'Preview'}
                    onClick={() =>
                      toggleVoicePreview(
                        'pick:__default__',
                        {
                          text: getSamplePreviewText(zh ? 'zh-CN' : 'en-US'),
                          overrideConfig: {
                            provider: 'system',
                            systemVoiceId: '',
                            systemSpeed: config.systemTts.speed,
                          },
                        },
                        (error) => {
                          const msg = describeReadAloudError(error)
                          showToast(typeof msg === 'string' ? msg : msg)
                        }
                      )
                    }
                  >
                    <SpeakerIcon active={playingId === 'pick:__default__'} />
                  </button>
                  <button
                    type="button"
                    className={clsx(styles.voiceSelectBtn, styles.checkCell)}
                    onClick={() => setSystemTtsVoiceId('')}
                  >
                    {config.systemTts.voiceId === '' ? '✓' : ''}
                  </button>
                </div>
              </div>
            ) : null}
            {filteredSystem.length === 0 ? (
              <div className={styles.emptyState}>
                {zh ? '未检测到本机可用音色' : 'No system voices found'}
              </div>
            ) : (
              filteredSystem.map((voice) => {
                const selected = config.systemTts.voiceId === voice.id
                const playing = playingId === `pick:sys:${voice.id}`
                return (
                  <div
                    key={voice.id}
                    className={clsx(styles.voiceRow, selected && styles.voiceRowSelected)}
                  >
                    <button
                      type="button"
                      className={styles.voiceSelectBtn}
                      onClick={() => setSystemTtsVoiceId(voice.id)}
                    >
                      <div className={styles.voiceName}>{voice.name}</div>
                      <div className={styles.voiceMeta}>{voice.meta}</div>
                    </button>
                    <div className={styles.voiceActions}>
                      <button
                        type="button"
                        className={clsx(
                          styles.inlineSpeakBtn,
                          playing && styles.inlineSpeakBtnPlaying
                        )}
                        aria-label={zh ? '试听' : 'Preview'}
                        onClick={() =>
                          toggleVoicePreview(
                            `pick:sys:${voice.id}`,
                            {
                              text: getSamplePreviewText(voice.locale),
                              overrideConfig: {
                                provider: 'system',
                                systemVoiceId: voice.id,
                                systemSpeed: config.systemTts.speed,
                              },
                            },
                            (error) => {
                              const msg = describeReadAloudError(error)
                              showToast(typeof msg === 'string' ? msg : msg)
                            }
                          )
                        }
                      >
                        <SpeakerIcon active={playing} />
                      </button>
                      <button
                        type="button"
                        className={clsx(styles.voiceSelectBtn, styles.checkCell)}
                        onClick={() => setSystemTtsVoiceId(voice.id)}
                      >
                        {selected ? '✓' : ''}
                      </button>
                    </div>
                  </div>
                )
              })
            )}
          </>
        )}
      </div>
    </div>
  )
}

export const VoiceAsrView = ({ variant }: { variant: 'android' | 'web' }) => {
  const zh = useIsZh()
  const config = useVoiceConfig((state) => state.config)
  const secrets = useVoiceConfig((state) => state.secrets)
  const [importOpen, setImportOpen] = useState(false)

  const importableProviders = useMemo(() => getImportableModelProviders(), [])

  const asrProviders: { id: AsrProviderId; label: string }[] = [
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'openai', label: zh ? 'OpenAI 兼容' : 'OpenAI-compatible' },
    { id: 'system', label: zh ? '系统识别' : 'System' },
  ]

  const languages: { id: AsrLanguage; label: string }[] = [
    { id: 'auto', label: zh ? '自动检测' : 'Auto' },
    { id: 'zh', label: zh ? '中文' : 'Chinese' },
    { id: 'en', label: zh ? '英语' : 'English' },
    { id: 'ja', label: zh ? '日语' : 'Japanese' },
  ]

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.card}>
        <div className={styles.cardTitle}>{zh ? '识别服务' : 'Speech recognition service'}</div>
        <div className={styles.grid3}>
          {asrProviders.map((item) => {
            const active = config.asrProvider === item.id
            return (
              <button
                key={item.id}
                type="button"
                className={clsx(styles.segmentBtn, active && styles.segmentBtnActive)}
                onClick={() => setAsrProvider(item.id)}
              >
                {item.label}
              </button>
            )
          })}
        </div>
      </div>

      {config.asrProvider === 'deepseek' ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>
            {zh ? '使用 DeepSeek 官方语音识别' : 'Use DeepSeek speech recognition'}
          </div>
          <div className={styles.mutedDesc}>
            {zh
              ? '直接使用已填写的 DeepSeek API Key，无需额外配置。'
              : 'Uses your configured DeepSeek API Key with no extra setup.'}
          </div>
        </div>
      ) : null}

      {config.asrProvider === 'system' ? (
        <div className={styles.card}>
          <div className={styles.cardTitle}>{zh ? '识别语言' : 'Language'}</div>
          <div className={styles.grid2}>
            {languages.map((item) => {
              const active = config.systemAsrLanguage === item.id
              return (
                <button
                  key={item.id}
                  type="button"
                  className={clsx(styles.segmentBtn, active && styles.segmentBtnActive)}
                  onClick={() => setSystemAsrLanguage(item.id)}
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>
      ) : null}

      {config.asrProvider === 'openai' ? (
        <div className={styles.card}>
          <div className={styles.cardHeaderRow}>
            <span className={styles.cardTitle}>{zh ? '快捷预设' : 'Presets'}</span>
            <button type="button" className={styles.linkBtn} onClick={() => setImportOpen(true)}>
              {zh ? '从模型服务导入' : 'Import from model service'}
            </button>
          </div>

          <div className={styles.chipWrap}>
            {(Object.keys(OPENAI_ASR_PRESETS) as OpenAiAsrPresetId[]).map((presetKey) => {
              const preset = OPENAI_ASR_PRESETS[presetKey]
              const on = config.openaiAsr.presetId === presetKey
              return (
                <button
                  key={presetKey}
                  type="button"
                  className={clsx(styles.chipBtn, on && styles.chipBtnActive)}
                  onClick={() => applyOpenAiAsrPreset(presetKey)}
                >
                  {zh ? preset.label : preset.labelEn}
                </button>
              )
            })}
          </div>

          <div className={styles.dividerTop}>
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>{zh ? '接口地址' : 'Base URL'}</label>
              <input
                type="url"
                className={styles.monoInput}
                value={config.openaiAsr.baseUrl}
                placeholder="https://api.openai.com/v1"
                onChange={(event) => updateOpenAiAsr({ baseUrl: event.target.value })}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>API Key</label>
              <input
                type="password"
                className={styles.monoInput}
                value={secrets.asrApiKey}
                placeholder="sk-..."
                autoComplete="off"
                onChange={(event) => setAsrApiKey(event.target.value)}
              />
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>{zh ? '模型' : 'Model'}</label>
              <input
                type="text"
                className={styles.monoInput}
                value={config.openaiAsr.model}
                placeholder="whisper-1"
                onChange={(event) => updateOpenAiAsr({ model: event.target.value })}
              />
            </div>

            <div className={styles.fieldGroup}>
              <span className={styles.fieldLabel}>{zh ? '识别语言' : 'Language'}</span>
              <div className={styles.grid4}>
                {languages.map((item) => {
                  const active = config.openaiAsr.language === item.id
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={clsx(styles.segmentBtn, active && styles.segmentBtnActive)}
                      onClick={() => updateOpenAiAsr({ language: item.id })}
                    >
                      {item.label}
                    </button>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <ImportProviderSheet
        open={importOpen}
        providers={importableProviders}
        zh={zh}
        onClose={() => setImportOpen(false)}
        onSelect={(provider) => {
          importModelProviderForAsr(provider)
          setImportOpen(false)
          showToast(zh ? `已导入 ${provider.name}` : `Imported ${provider.name}`)
        }}
      />
    </div>
  )
}

export const DesktopVoiceSettings = ({ initialTab = 'tts' }: { initialTab?: 'tts' | 'asr' }) => {
  const zh = useIsZh()
  const [tab, setTab] = useState<'tts' | 'asr'>(initialTab)
  const [pickerMode, setPickerMode] = useState<'edge' | 'system' | null>(null)

  useEffect(() => {
    setTab(initialTab)
    setPickerMode(null)
  }, [initialTab])

  useEffect(() => () => stopVoicePreview(), [])

  return (
    <div className={styles.container}>
      {pickerMode ? (
        <VoicePickerView
          variant="web"
          mode={pickerMode}
          onBack={() => {
            stopVoicePreview()
            setPickerMode(null)
          }}
        />
      ) : (
        <>
          <div className={styles.desktopTabs}>
            <button
              type="button"
              className={clsx(styles.desktopTabBtn, tab === 'tts' && styles.desktopTabBtnActive)}
              onClick={() => {
                stopVoicePreview()
                setTab('tts')
              }}
            >
              {zh ? '语音朗读' : 'Read aloud'}
            </button>
            <button
              type="button"
              className={clsx(styles.desktopTabBtn, tab === 'asr' && styles.desktopTabBtnActive)}
              onClick={() => {
                stopVoicePreview()
                setTab('asr')
              }}
            >
              {zh ? '语音输入' : 'Voice input'}
            </button>
          </div>
          {tab === 'tts' ? (
            <VoiceTtsView variant="web" onOpenVoicePicker={(mode) => setPickerMode(mode)} />
          ) : (
            <VoiceAsrView variant="web" />
          )}
        </>
      )}
    </div>
  )
}
