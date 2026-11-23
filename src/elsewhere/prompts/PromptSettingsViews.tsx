import clsx from 'clsx'
import { useEffect, useState } from 'react'
import { IconChevronRightOutline14 } from '../../components/base/icons.js'
import { useIsZh } from '../text.js'
import {
  createPromptPreset,
  deletePromptPreset,
  setDefaultPromptPreset,
  updatePromptPreset,
  useSystemPrompts,
} from './config.js'
import styles from './PromptSettingsViews.module.css'

export const SystemPromptListView = ({
  variant,
  onCreate,
  onEdit,
}: {
  variant: 'web' | 'android'
  onCreate: () => void
  onEdit: (presetId: string) => void
}) => {
  const zh = useIsZh()
  const presets = useSystemPrompts((state) => state.presets)
  const defaultPresetId = useSystemPrompts((state) => state.defaultPresetId)

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.topBar}>
          <span className={styles.pageTitle}>{zh ? '系统指令' : 'System instructions'}</span>
          <button type="button" className={styles.secondaryButton} onClick={onCreate}>
            {zh ? '+ 新建' : '+ New'}
          </button>
        </div>
      ) : null}

      <div className={styles.card}>
        <div className={styles.cardTitle}>
          {zh ? '全局默认指令' : 'Global default instruction'}
        </div>
        <div className={styles.chips} role="radiogroup" aria-label={zh ? '全局默认指令' : 'Global default instruction'}>
          <button
            type="button"
            role="radio"
            aria-checked={defaultPresetId === null}
            className={clsx(styles.chip, defaultPresetId === null && styles.chipSelected)}
            onClick={() => setDefaultPromptPreset(null)}
          >
            {zh ? '无' : 'None'}
          </button>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={defaultPresetId === preset.id}
              className={clsx(styles.chip, defaultPresetId === preset.id && styles.chipSelected)}
              onClick={() => setDefaultPromptPreset(preset.id)}
            >
              {preset.name}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.sectionLabel}>{zh ? '指令预设' : 'Presets'}</div>

      {presets.length === 0 ? (
        <div className={styles.card}>
          <div className={styles.emptyNotice}>
            {zh ? '暂无预设，点击右上「+ 新建」创建' : 'No presets yet'}
          </div>
        </div>
      ) : (
        <div className={styles.presetList}>
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={styles.presetCard}
              onClick={() => onEdit(preset.id)}
            >
              <div className={styles.presetHeader}>
                <span className={styles.presetName}>{preset.name}</span>
                <span className={styles.presetEditHint}>
                  {zh ? '编辑' : 'Edit'}
                  <IconChevronRightOutline14 />
                </span>
              </div>
              <div className={styles.presetPreview}>{preset.content}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export const SystemPromptEditView = ({
  variant,
  presetId,
  formId = 'system-prompt-edit-form',
  onBack,
  onSaved,
  onDeleted,
}: {
  variant: 'web' | 'android'
  presetId: string | null
  formId?: string
  onBack?: () => void
  onSaved: () => void
  onDeleted: () => void
}) => {
  const zh = useIsZh()
  const existing = useSystemPrompts((state) =>
    presetId ? state.presets.find((item) => item.id === presetId) : undefined
  )
  const [name, setName] = useState(existing?.name ?? '')
  const [content, setContent] = useState(existing?.content ?? '')
  const [error, setError] = useState('')

  useEffect(() => {
    setName(existing?.name ?? '')
    setContent(existing?.content ?? '')
    setError('')
  }, [presetId, existing?.name, existing?.content])

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError(zh ? '请填写预设名称' : 'Enter a preset name')
      return
    }
    if (!content.trim()) {
      setError(zh ? '请填写指令内容' : 'Enter instruction content')
      return
    }
    if (existing) {
      if (updatePromptPreset(existing.id, { name, content })) {
        onSaved()
      }
      return
    }
    if (createPromptPreset({ name, content })) {
      onSaved()
    }
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
          <span className={styles.pageTitle}>
            {existing ? (zh ? '编辑指令预设' : 'Edit preset') : zh ? '新建指令预设' : 'New preset'}
          </span>
        </div>
      ) : null}

      <div className={styles.card}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>{zh ? '名称' : 'Name'}</span>
          <input
            className={styles.input}
            value={name}
            placeholder={zh ? '如 直白克制' : 'Preset name'}
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>{zh ? '指令内容' : 'Instruction'}</span>
          <textarea
            className={styles.textarea}
            value={content}
            placeholder={zh ? '输入系统指令内容…' : 'Enter system instruction…'}
            onChange={(event) => {
              setContent(event.target.value)
              setError('')
            }}
          />
        </label>

        {error ? (
          <div className={styles.errorText} role="alert">
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

      {existing ? (
        <button
          type="button"
          className={styles.dangerButton}
          onClick={() => {
            if (deletePromptPreset(existing.id)) {
              onDeleted()
            }
          }}
        >
          {zh ? '删除此预设' : 'Delete preset'}
        </button>
      ) : null}
    </form>
  )
}

export const SystemPromptsSettings = () => {
  const [editingId, setEditingId] = useState<string | null | undefined>(undefined)

  if (editingId !== undefined) {
    return (
      <SystemPromptEditView
        variant="web"
        presetId={editingId}
        onBack={() => setEditingId(undefined)}
        onSaved={() => setEditingId(undefined)}
        onDeleted={() => setEditingId(undefined)}
      />
    )
  }

  return (
    <SystemPromptListView
      variant="web"
      onCreate={() => setEditingId(null)}
      onEdit={(id) => setEditingId(id)}
    />
  )
}
