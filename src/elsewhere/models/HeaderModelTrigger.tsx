import clsx from 'clsx'
import { android } from '../../app/android.js'
import { IconChevronDownOutline14 } from '../../components/base/icons.js'
import { useChatStore } from '../../services/chat/store.js'
import { useIsZh } from '../text.js'
import { resolveEffectivePrompt, useSystemPrompts } from '../prompts/config.js'
import { useModelProviders } from './config.js'
import { openModelDrawer, useDraftSessionConfig } from './sessionDrawerState.js'
import styles from './HeaderModelTrigger.module.css'

const useCurrentTriggerSubtitle = (): string => {
  const activeId = useChatStore((state) => state.activeId)
  const session = useChatStore((state) =>
    state.activeId !== null && Object.hasOwn(state.sessionCache, state.activeId)
      ? state.sessionCache[state.activeId]
      : undefined
  )
  const draftPromptOverride = useDraftSessionConfig((state) => state.promptOverride)
  const providers = useModelProviders((state) => state.providers)
  const activeModel = useModelProviders((state) => state.activeModel)
  const presets = useSystemPrompts((state) => state.presets)
  const defaultPresetId = useSystemPrompts((state) => state.defaultPresetId)

  const provider = providers.find((item) => item.id === activeModel.providerId)
  const model = provider?.models.find((item) => item.id === activeModel.modelId)
  const modelLabel = model?.label || activeModel.modelId || 'DeepSeek Flash'

  const effectiveOverride = activeId !== null ? session?.promptOverride : draftPromptOverride
  const { preset } = resolveEffectivePrompt(presets, defaultPresetId, effectiveOverride)
  return preset ? `${modelLabel} · ${preset.name}` : modelLabel
}

export const HeaderModelTrigger = ({ title }: { title?: string }) => {
  const zh = useIsZh()
  const subtitle = useCurrentTriggerSubtitle()
  const ariaLabel = zh ? `切换模型或会话设置（当前：${subtitle}）` : `Switch model or session settings (${subtitle})`

  if (title === undefined) {
    return (
      <div className={styles.centerSlot} data-side-shift={android ? 'edge' : undefined}>
        <button
          type="button"
          className={styles.pillButton}
          aria-label={ariaLabel}
          onClick={() => openModelDrawer('model')}
        >
          <span className={styles.pillText}>{subtitle}</span>
          <span className={styles.chevron} aria-hidden="true">
            <IconChevronDownOutline14 />
          </span>
        </button>
      </div>
    )
  }

  return (
    <div className={styles.centerSlot} data-side-shift={android ? 'edge' : undefined}>
      <button
        type="button"
        className={styles.sessionButton}
        aria-label={ariaLabel}
        onClick={() => openModelDrawer('model')}
      >
        <span className={styles.sessionTitle}>{title}</span>
        <span className={styles.sessionSubRow}>
          <span className={styles.sessionSubText}>{subtitle}</span>
          <span className={styles.chevron} aria-hidden="true">
            <IconChevronDownOutline14 />
          </span>
        </span>
      </button>
    </div>
  )
}

export const DesktopModelTrigger = ({ className }: { className?: string }) => {
  const zh = useIsZh()
  const subtitle = useCurrentTriggerSubtitle()
  const ariaLabel = zh ? `切换模型或会话设置（当前：${subtitle}）` : `Switch model or session settings (${subtitle})`

  return (
    <button
      type="button"
      className={clsx(styles.desktopTrigger, className)}
      aria-label={ariaLabel}
      onClick={() => openModelDrawer('model')}
    >
      <span className={styles.pillText}>{subtitle}</span>
      <span className={styles.chevron} aria-hidden="true">
        <IconChevronDownOutline14 />
      </span>
    </button>
  )
}
