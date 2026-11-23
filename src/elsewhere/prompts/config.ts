import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { injectLocalDateTime } from '../tools/systemTime.js'
import { createBuiltinPromptPresets } from './presets.js'
import type { SessionPromptOverride, SystemPromptPreset } from './types.js'

const STORAGE_KEY = 'elsewhere:system-prompts-v1'

type StoredSystemPrompts = {
  initialized: boolean
  defaultPresetId: string | null
  presets: SystemPromptPreset[]
}

const readStorage = (): string | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const writeStorage = (data: StoredSystemPrompts) => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    }
  } catch {
    // 隐私模式或存储受限时仍保持内存状态
  }
}

const normalizePreset = (raw: unknown): SystemPromptPreset | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  const content = typeof obj.content === 'string' ? obj.content : ''
  if (!id || !name) {
    return null
  }
  const now = Date.now()
  return {
    id,
    name,
    content,
    ...(obj.builtin ? { builtin: true } : {}),
    createdAt: typeof obj.createdAt === 'number' && Number.isFinite(obj.createdAt) ? obj.createdAt : now,
    updatedAt: typeof obj.updatedAt === 'number' && Number.isFinite(obj.updatedAt) ? obj.updatedAt : now,
  }
}

const loadInitialState = (): {
  defaultPresetId: string | null
  presets: SystemPromptPreset[]
} => {
  const raw = readStorage()
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Partial<StoredSystemPrompts>
        if (obj.initialized && Array.isArray(obj.presets)) {
          const presets = obj.presets
            .map(normalizePreset)
            .filter((item): item is SystemPromptPreset => item !== null)
          const defaultPresetId =
            typeof obj.defaultPresetId === 'string' &&
            presets.some((item) => item.id === obj.defaultPresetId)
              ? obj.defaultPresetId
              : null
          return { defaultPresetId, presets }
        }
      }
    } catch {
      // 存储异常时恢复内置范例
    }
  }
  const presets = createBuiltinPromptPresets()
  const initial: StoredSystemPrompts = {
    initialized: true,
    defaultPresetId: null,
    presets,
  }
  writeStorage(initial)
  return { defaultPresetId: null, presets }
}

type SystemPromptsState = {
  defaultPresetId: string | null
  presets: SystemPromptPreset[]
}

export const useSystemPrompts = create<SystemPromptsState>(loadInitialState)

const commitPrompts = (defaultPresetId: string | null, presets: SystemPromptPreset[]) => {
  const validDefault =
    defaultPresetId && presets.some((item) => item.id === defaultPresetId) ? defaultPresetId : null
  writeStorage({
    initialized: true,
    defaultPresetId: validDefault,
    presets,
  })
  useSystemPrompts.setState({ defaultPresetId: validDefault, presets })
}

export const setDefaultPromptPreset = (presetId: string | null) => {
  const { presets } = useSystemPrompts.getState()
  commitPrompts(presetId, presets)
}

export const createPromptPreset = (input: { name: string; content: string }): SystemPromptPreset | null => {
  const name = input.name.trim()
  const content = input.content.trim()
  if (!name || !content) {
    return null
  }
  const now = Date.now()
  const created: SystemPromptPreset = {
    id: `prompt-${createId()}`,
    name,
    content,
    createdAt: now,
    updatedAt: now,
  }
  const { defaultPresetId, presets } = useSystemPrompts.getState()
  commitPrompts(defaultPresetId, [...presets, created])
  return created
}

export const updatePromptPreset = (
  id: string,
  patch: { name: string; content: string }
): boolean => {
  const name = patch.name.trim()
  const content = patch.content.trim()
  if (!name || !content) {
    return false
  }
  const { defaultPresetId, presets } = useSystemPrompts.getState()
  let found = false
  const next = presets.map((item) => {
    if (item.id !== id) {
      return item
    }
    found = true
    return {
      ...item,
      name,
      content,
      updatedAt: Date.now(),
    }
  })
  if (!found) {
    return false
  }
  commitPrompts(defaultPresetId, next)
  return true
}

export const deletePromptPreset = (id: string): boolean => {
  const { defaultPresetId, presets } = useSystemPrompts.getState()
  const next = presets.filter((item) => item.id !== id)
  if (next.length === presets.length) {
    return false
  }
  commitPrompts(defaultPresetId === id ? null : defaultPresetId, next)
  return true
}

export const resolveEffectivePrompt = (
  presets: readonly SystemPromptPreset[],
  defaultPresetId: string | null,
  override?: SessionPromptOverride
): { preset: SystemPromptPreset | null; isCustomActive: boolean } => {
  if (override?.mode === 'none') {
    return { preset: null, isCustomActive: false }
  }
  if (override?.mode === 'preset') {
    const matched = presets.find((item) => item.id === override.presetId) ?? null
    if (matched) {
      return { preset: matched, isCustomActive: true }
    }
  }
  if (!defaultPresetId) {
    return { preset: null, isCustomActive: false }
  }
  const fallback = presets.find((item) => item.id === defaultPresetId) ?? null
  return { preset: fallback, isCustomActive: fallback !== null }
}

export const buildRequestSystemPrompt = ({
  customEndpoint,
  officialDefaultPrompt,
  effectivePromptContent,
  now,
}: {
  customEndpoint: boolean
  officialDefaultPrompt: string
  effectivePromptContent: string
  now?: Date
}): string => {
  const trimmed = effectivePromptContent.trim()
  if (!customEndpoint) {
    return trimmed || officialDefaultPrompt
  }
  return injectLocalDateTime(trimmed, now)
}
