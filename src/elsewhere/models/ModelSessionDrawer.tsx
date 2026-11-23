import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { android } from '../../app/android.js'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useIsMobile } from '../../app/viewport.js'
import {
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconChevronRightOutline14,
  IconSearchOutline16,
} from '../../components/base/icons.js'
import { openSettings } from '../../components/settings/settingsDialogState.js'
import {
  updateSessionModelRef,
  updateSessionPromptOverride,
  updateSessionReasoningEffort,
  updateSessionSampling,
  useChatStore,
} from '../../services/chat/store.js'
import { useSystemPrompts } from '../prompts/config.js'
import type { SessionPromptOverride } from '../prompts/types.js'
import { useIsZh } from '../text.js'
import {
  getEnabledModelGroups,
  selectActiveModel,
  useModelProviders,
} from './config.js'
import {
  closeModelDrawer,
  setDraftPromptOverride,
  setDraftReasoningEffort,
  setDraftSampling,
  setModelDrawerTab,
  useDraftSessionConfig,
  useModelDrawer,
} from './sessionDrawerState.js'
import type { ReasoningEffort, SamplingParams } from './types.js'
import styles from './ModelSessionDrawer.module.css'

export const ModelSessionDrawer = () => {
  const open = useModelDrawer((state) => state.open)
  if (!open) {
    return null
  }
  return <ModelSessionDrawerContent />
}

const EFFORT_OPTIONS: ReadonlyArray<{ value: ReasoningEffort; zh: string; en: string }> = [
  { value: 'auto', zh: '自动', en: 'Auto' },
  { value: 'low', zh: '低', en: 'Low' },
  { value: 'medium', zh: '中', en: 'Medium' },
  { value: 'high', zh: '高', en: 'High' },
]

const isSamePromptOverride = (a: SessionPromptOverride, b: SessionPromptOverride): boolean => {
  if (a.mode !== b.mode) {
    return false
  }
  if (a.mode === 'preset' && b.mode === 'preset') {
    return a.presetId === b.presetId
  }
  return true
}

const ModelSessionDrawerContent = () => {
  const zh = useIsZh()
  const isMobile = useIsMobile()
  const bottomSheet = isMobile || Boolean(android)
  const tab = useModelDrawer((state) => state.tab)
  const [query, setQuery] = useState('')
  const [samplingOpen, setSamplingOpen] = useState(false)

  const providers = useModelProviders((state) => state.providers)
  const activeModel = useModelProviders((state) => state.activeModel)
  const presets = useSystemPrompts((state) => state.presets)
  const defaultPresetId = useSystemPrompts((state) => state.defaultPresetId)

  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const draft = useDraftSessionConfig()

  useAndroidBackInterception(true)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeModelDrawer()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  const currentPromptOverride: SessionPromptOverride =
    activeId !== null ? (session?.promptOverride ?? { mode: 'follow' }) : draft.promptOverride
  const currentEffort: ReasoningEffort =
    activeId !== null ? (session?.reasoningEffort ?? 'auto') : draft.reasoningEffort
  const currentSampling: SamplingParams =
    activeId !== null ? (session?.sampling ?? {}) : draft.sampling

  const handlePromptChange = (override: SessionPromptOverride) => {
    if (activeId !== null) {
      updateSessionPromptOverride(activeId, override)
    } else {
      setDraftPromptOverride(override)
    }
  }

  const handleEffortChange = (effort: ReasoningEffort) => {
    if (activeId !== null) {
      updateSessionReasoningEffort(activeId, effort)
    } else {
      setDraftReasoningEffort(effort)
    }
  }

  const handleSamplingChange = (next: SamplingParams) => {
    if (activeId !== null) {
      updateSessionSampling(activeId, next)
    } else {
      setDraftSampling(next)
    }
  }

  const defaultPreset = defaultPresetId
    ? presets.find((item) => item.id === defaultPresetId) ?? null
    : null
  const followLabel = zh
    ? `跟随默认（${defaultPreset ? defaultPreset.name : '无'}）`
    : `Follow default (${defaultPreset ? defaultPreset.name : 'None'})`

  const normalizedQuery = query.trim().toLowerCase()
  const enabledGroups = getEnabledModelGroups(providers)
    .map((group) => {
      if (!normalizedQuery) {
        return group
      }
      const providerMatches = group.provider.name.toLowerCase().includes(normalizedQuery)
      if (providerMatches) {
        return group
      }
      const models = group.models.filter(
        (model) =>
          model.label.toLowerCase().includes(normalizedQuery) ||
          model.id.toLowerCase().includes(normalizedQuery)
      )
      return { ...group, models }
    })
    .filter((group) => group.models.length > 0)

  const hasCustomSampling =
    currentSampling.temperature != null || currentSampling.topP != null
  const samplingSummary = hasCustomSampling
    ? [
        currentSampling.temperature != null ? `T ${currentSampling.temperature.toFixed(1)}` : '',
        currentSampling.topP != null ? `P ${currentSampling.topP.toFixed(2)}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : zh
      ? '跟随模型默认'
      : 'Model default'

  return createPortal(
    <div
      className={clsx(styles.overlay, bottomSheet && styles.sheetOverlay)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          closeModelDrawer()
        }
      }}
    >
      <section
        className={clsx(styles.panel, bottomSheet && styles.sheet)}
        role="dialog"
        aria-modal="true"
        aria-label={zh ? '模型与会话参数' : 'Model & Session Settings'}
      >
        {bottomSheet ? <div className={styles.handle} aria-hidden="true" /> : null}

        <div className={styles.segmentedWrap}>
          <div className={styles.segmented} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'model'}
              className={clsx(styles.segmentBtn, tab === 'model' && styles.segmentBtnActive)}
              onClick={() => setModelDrawerTab('model')}
            >
              {zh ? '模型' : 'Model'}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'prompt'}
              className={clsx(styles.segmentBtn, tab === 'prompt' && styles.segmentBtnActive)}
              onClick={() => setModelDrawerTab('prompt')}
            >
              {zh ? '指令与参数' : 'Instructions & Params'}
            </button>
          </div>
        </div>

        <div className={styles.body}>
          {tab === 'model' ? (
            <>
              <div className={styles.searchWrap}>
                <span className={styles.searchIcon} aria-hidden="true">
                  <IconSearchOutline16 />
                </span>
                <input
                  type="search"
                  className={styles.searchInput}
                  placeholder={zh ? '搜索已启用模型' : 'Search enabled models'}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>

              {enabledGroups.length === 0 ? (
                <div className={styles.emptyState}>
                  {zh ? '未找到匹配的已启用模型' : 'No matching enabled models'}
                </div>
              ) : (
                <div className={styles.groupList}>
                  {enabledGroups.map(({ provider, models }) => (
                    <div key={provider.id} className={styles.group}>
                      <div className={styles.groupTitle}>{provider.name}</div>
                      <div className={styles.card}>
                        {models.map((model) => {
                          const selected =
                            activeModel.providerId === provider.id &&
                            activeModel.modelId === model.id
                          return (
                            <button
                              key={model.id}
                              type="button"
                              className={clsx(styles.modelRow, selected && styles.modelRowSelected)}
                              onClick={() => {
                                const ref = { providerId: provider.id, modelId: model.id }
                                if (selectActiveModel(ref) && activeId !== null) {
                                  updateSessionModelRef(activeId, ref)
                                }
                                closeModelDrawer()
                              }}
                            >
                              <div className={styles.modelText}>
                                <span className={styles.modelLabel}>{model.label || model.id}</span>
                                {model.label && model.label !== model.id ? (
                                  <span className={styles.modelId}>{model.id}</span>
                                ) : null}
                              </div>
                              {selected ? (
                                <span className={styles.checkIcon} aria-hidden="true">
                                  <IconCheckOutline16 />
                                </span>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                className={styles.manageButton}
                onClick={() => {
                  closeModelDrawer()
                  openSettings('models')
                }}
              >
                <span>{zh ? '管理模型服务' : 'Manage model providers'}</span>
                <IconChevronRightOutline14 />
              </button>
            </>
          ) : (
            <div className={styles.paramsWrap}>
              <div className={styles.sectionBlock}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>
                    {zh ? '本会话系统指令' : 'Session system instruction'}
                  </span>
                  <button
                    type="button"
                    className={styles.linkAction}
                    onClick={() => {
                      closeModelDrawer()
                      openSettings('prompts')
                    }}
                  >
                    {zh ? '管理预设' : 'Manage'}
                  </button>
                </div>
                <div className={styles.chips} role="radiogroup" aria-label={zh ? '本会话系统指令' : 'Session system instruction'}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSamePromptOverride(currentPromptOverride, { mode: 'follow' })}
                    className={clsx(
                      styles.chip,
                      isSamePromptOverride(currentPromptOverride, { mode: 'follow' }) &&
                        styles.chipSelected
                    )}
                    onClick={() => handlePromptChange({ mode: 'follow' })}
                  >
                    {followLabel}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isSamePromptOverride(currentPromptOverride, { mode: 'none' })}
                    className={clsx(
                      styles.chip,
                      isSamePromptOverride(currentPromptOverride, { mode: 'none' }) &&
                        styles.chipSelected
                    )}
                    onClick={() => handlePromptChange({ mode: 'none' })}
                  >
                    {zh ? '无' : 'None'}
                  </button>
                  {presets.map((preset) => {
                    const target: SessionPromptOverride = { mode: 'preset', presetId: preset.id }
                    const selected = isSamePromptOverride(currentPromptOverride, target)
                    return (
                      <button
                        key={preset.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={clsx(styles.chip, selected && styles.chipSelected)}
                        onClick={() => handlePromptChange(target)}
                      >
                        {preset.name}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className={styles.sectionBlock}>
                <div className={styles.sectionHeader}>
                  <span className={styles.sectionTitle}>{zh ? '思考强度' : 'Reasoning effort'}</span>
                </div>
                <div className={styles.effortGrid} role="radiogroup" aria-label={zh ? '思考强度' : 'Reasoning effort'}>
                  {EFFORT_OPTIONS.map((opt) => {
                    const selected = currentEffort === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={clsx(styles.effortBtn, selected && styles.effortBtnActive)}
                        onClick={() => handleEffortChange(opt.value)}
                      >
                        {zh ? opt.zh : opt.en}
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className={styles.card}>
                <button
                  type="button"
                  className={styles.collapseHeader}
                  aria-expanded={samplingOpen}
                  onClick={() => setSamplingOpen((openState) => !openState)}
                >
                  <span className={styles.collapseTitle}>{zh ? '采样参数' : 'Sampling'}</span>
                  <span className={styles.collapseRight}>
                    <span>{samplingSummary}</span>
                    <span className={clsx(styles.collapseArrow, samplingOpen && styles.collapseArrowOpen)}>
                      <IconChevronDownOutline14 />
                    </span>
                  </span>
                </button>
                {samplingOpen ? (
                  <div className={styles.samplingBody}>
                    <div className={styles.sliderRow}>
                      <div className={styles.sliderTop}>
                        <span>Temperature</span>
                        <span className={styles.sliderValue}>
                          {currentSampling.temperature != null
                            ? currentSampling.temperature.toFixed(1)
                            : zh
                              ? '默认'
                              : 'Default'}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="Temperature"
                        min={0}
                        max={2}
                        step={0.1}
                        value={currentSampling.temperature ?? 1}
                        className={styles.slider}
                        onChange={(event) =>
                          handleSamplingChange({
                            ...currentSampling,
                            temperature: Number(event.target.value),
                          })
                        }
                      />
                    </div>
                    <div className={styles.sliderRow}>
                      <div className={styles.sliderTop}>
                        <span>Top-P</span>
                        <span className={styles.sliderValue}>
                          {currentSampling.topP != null
                            ? currentSampling.topP.toFixed(2)
                            : zh
                              ? '默认'
                              : 'Default'}
                        </span>
                      </div>
                      <input
                        type="range"
                        aria-label="Top-P"
                        min={0}
                        max={1}
                        step={0.05}
                        value={currentSampling.topP ?? 1}
                        className={styles.slider}
                        onChange={(event) =>
                          handleSamplingChange({
                            ...currentSampling,
                            topP: Number(event.target.value),
                          })
                        }
                      />
                    </div>
                    {hasCustomSampling ? (
                      <button
                        type="button"
                        className={styles.resetButton}
                        onClick={() => handleSamplingChange({ temperature: null, topP: null })}
                      >
                        {zh ? '恢复模型默认' : 'Reset to model default'}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>,
    document.body
  )
}
