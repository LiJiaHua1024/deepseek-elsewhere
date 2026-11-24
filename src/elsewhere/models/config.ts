import { create } from 'zustand'
import { android } from '../../app/android.js'
import {
  DEFAULT_CHAT_CONFIG,
  DEFAULT_CHAT_MODEL,
  chatBaseUrl,
  resolveChatEndpoint,
  type ChatApiFormat,
  type ChatConfig,
} from '../../services/api/chatConfig.js'
import { setChatConfig, useSettings } from '../../services/settings.js'
import { createId } from '../../utils/id.js'
import {
  mergeFetchedModels,
  normalizeProviderBaseUrl,
  type ParsedRemoteModel,
} from './fetchModels.js'
import { BUILTIN_DEEPSEEK_ID, createDefaultProviders, inferModelGroup } from './presets.js'
import type { ActiveModelRef, ModelProviderConfig, ProviderModelItem } from './types.js'

const PROVIDERS_STORAGE_KEY = 'elsewhere:model-providers-v1'
const ACTIVE_MODEL_STORAGE_KEY = 'elsewhere:active-model-v1'
const PROVIDER_SECRETS_STORAGE_KEY = 'elsewhere:provider-secrets-v1'

const readStorage = (key: string): string | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeStorage = (key: string, value: string | null): boolean => {
  try {
    if (typeof localStorage === 'undefined') {
      return false
    }
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
    return true
  } catch {
    return false
  }
}

const readProviderSecrets = (): Record<string, string> => {
  try {
    const raw = android?.readProviderSecrets
      ? android.readProviderSecrets()
      : readStorage(PROVIDER_SECRETS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) {
        result[key] = value
      }
    }
    return result
  } catch {
    return {}
  }
}

const writeProviderSecrets = (providers: readonly ModelProviderConfig[]): boolean => {
  const secrets: Record<string, string> = {}
  for (const provider of providers) {
    if (!provider.builtin && provider.apiKey.trim()) {
      secrets[provider.id] = provider.apiKey.trim()
    }
  }
  const serialized = Object.keys(secrets).length > 0 ? JSON.stringify(secrets) : null
  if (android?.writeProviderSecrets) {
    return android.writeProviderSecrets(serialized)
  }
  return writeStorage(PROVIDER_SECRETS_STORAGE_KEY, serialized)
}

type StoredProviderItem = Omit<ModelProviderConfig, 'apiKey'>

const stripSecrets = (providers: readonly ModelProviderConfig[]): StoredProviderItem[] =>
  providers.map(({ id, name, builtin, format, baseUrl, enabled, models }) => ({
    id,
    name,
    ...(builtin ? { builtin } : {}),
    format,
    baseUrl,
    enabled,
    models,
  }))

const persistState = (providers: readonly ModelProviderConfig[], activeModel: ActiveModelRef) => {
  writeStorage(PROVIDERS_STORAGE_KEY, JSON.stringify(stripSecrets(providers)))
  writeStorage(ACTIVE_MODEL_STORAGE_KEY, JSON.stringify(activeModel))
  writeProviderSecrets(providers)
}

const isChatFormat = (value: unknown): value is ChatApiFormat =>
  value === 'messages' || value === 'chat' || value === 'responses'

const normalizeModelItem = (raw: unknown): ProviderModelItem | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const item = raw as Record<string, unknown>
  const id = typeof item.id === 'string' ? item.id.trim() : ''
  if (!id) {
    return null
  }
  const label = typeof item.label === 'string' && item.label.trim() ? item.label.trim() : id
  const group =
    typeof item.group === 'string' && item.group.trim() ? item.group.trim() : inferModelGroup(id)
  const contextWindow =
    typeof item.contextWindow === 'number' &&
    Number.isSafeInteger(item.contextWindow) &&
    item.contextWindow >= 1024
      ? item.contextWindow
      : undefined
  return {
    id,
    label,
    group,
    enabled: Boolean(item.enabled),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  }
}

const normalizeProvider = (
  raw: unknown,
  secrets: Readonly<Record<string, string>>
): ModelProviderConfig | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  const id = typeof obj.id === 'string' ? obj.id.trim() : ''
  const name = typeof obj.name === 'string' ? obj.name.trim() : ''
  if (!id || !name) {
    return null
  }
  const builtin = id === BUILTIN_DEEPSEEK_ID || Boolean(obj.builtin)
  const format: ChatApiFormat = isChatFormat(obj.format) ? obj.format : 'chat'
  const rawBaseUrl = typeof obj.baseUrl === 'string' ? obj.baseUrl.trim() : ''
  const baseUrl = builtin ? '' : (normalizeProviderBaseUrl(rawBaseUrl) ?? rawBaseUrl)
  const apiKey = builtin
    ? ''
    : typeof secrets[id] === 'string'
      ? secrets[id]
      : typeof obj.apiKey === 'string'
        ? obj.apiKey.trim()
        : ''
  const seenModels = new Set<string>()
  const models: ProviderModelItem[] = []
  if (Array.isArray(obj.models)) {
    for (const rawModel of obj.models) {
      const normalized = normalizeModelItem(rawModel)
      if (normalized && !seenModels.has(normalized.id)) {
        seenModels.add(normalized.id)
        models.push(normalized)
      }
    }
  }
  return {
    id,
    name,
    ...(builtin ? { builtin: true } : {}),
    format,
    baseUrl,
    apiKey,
    enabled: Boolean(obj.enabled),
    models,
  }
}

const ensureBuiltinProvider = (providers: ModelProviderConfig[]): ModelProviderConfig[] => {
  const defaults = createDefaultProviders()
  const deepseekDefault = defaults[0]
  const existingDeepSeek = providers.find((item) => item.id === BUILTIN_DEEPSEEK_ID)
  if (!existingDeepSeek) {
    return [deepseekDefault, ...providers]
  }
  const others = providers.filter((item) => item.id !== BUILTIN_DEEPSEEK_ID)
  // 旧版本把已退役的 deepseek-pro 预置为 Pro；升级到 V4 后迁移到 deepseek-v4-pro。
  const legacyProAlias = 'deepseek-pro'
  const v4Pro = deepseekDefault.models.find((item) => item.id === 'deepseek-v4-pro')
  const rawModels =
    existingDeepSeek.models.length > 0
      ? existingDeepSeek.models.some((item) => item.id === legacyProAlias)
        ? existingDeepSeek.models.map((item) =>
            item.id === legacyProAlias
              ? {
                  ...item,
                  id: v4Pro?.id ?? 'deepseek-v4-pro',
                  label: v4Pro?.label ?? item.label,
                }
              : item
          )
        : existingDeepSeek.models
      : deepseekDefault.models
  // 若旧配置中同时存在 deepseek-pro 与 deepseek-v4-pro，迁移后按 id 去重并保留启用态。
  const mergedModels: ProviderModelItem[] = []
  const seenIds = new Set<string>()
  for (const item of rawModels) {
    if (seenIds.has(item.id)) {
      const existing = mergedModels.find((entry) => entry.id === item.id)
      if (existing && item.enabled) {
        existing.enabled = true
      }
      continue
    }
    seenIds.add(item.id)
    mergedModels.push({ ...item })
  }
  return [
    {
      ...existingDeepSeek,
      builtin: true,
      name: existingDeepSeek.name || deepseekDefault.name,
      baseUrl: '',
      apiKey: '',
      models: mergedModels,
    },
    ...others,
  ]
}

const upsertEnabledModel = (
  models: readonly ProviderModelItem[],
  modelId: string,
  preferredGroup?: string
): ProviderModelItem[] => {
  const trimmed = modelId.trim()
  if (!trimmed) {
    return [...models]
  }
  const existingIndex = models.findIndex((item) => item.id === trimmed)
  if (existingIndex >= 0) {
    return models.map((item, idx) =>
      idx === existingIndex ? { ...item, enabled: true } : item
    )
  }
  return [
    ...models,
    {
      id: trimmed,
      label: trimmed,
      group: preferredGroup ?? inferModelGroup(trimmed),
      enabled: true,
    },
  ]
}

const matchesProviderBaseUrl = (
  candidateBaseUrl: string,
  normalizedLegacyBase: string,
  format: ChatApiFormat
): boolean => {
  const candidate = normalizeProviderBaseUrl(candidateBaseUrl)
  if (!candidate) {
    return false
  }
  const left = candidate.toLowerCase()
  const right = normalizedLegacyBase.toLowerCase()
  if (left === right) {
    return true
  }
  if (format === 'messages' && !left.endsWith('/v1') && `${left}/v1` === right) {
    return true
  }
  return false
}

export const migrateLegacyChatConfig = (
  legacy: ChatConfig,
  basePresets: ModelProviderConfig[] = createDefaultProviders()
): { providers: ModelProviderConfig[]; activeModel: ActiveModelRef } => {
  const providers = ensureBuiltinProvider(
    basePresets.map((provider) => ({
      ...provider,
      models: provider.models.map((model) => ({ ...model })),
    }))
  )

  // 旧版默认的 deepseek-pro 已退役，迁移到当前 V4 Pro。
  const legacyModel = legacy.model.trim().replace(/^deepseek-pro$/i, 'deepseek-v4-pro')
  if (!legacy.endpoint.trim()) {
    const modelId = legacyModel || DEFAULT_CHAT_MODEL
    const updated = providers.map((provider) =>
      provider.id === BUILTIN_DEEPSEEK_ID
        ? {
            ...provider,
            enabled: true,
            format: legacy.format,
            models: upsertEnabledModel(provider.models, modelId, 'DeepSeek'),
          }
        : provider
    )
    return {
      providers: updated,
      activeModel: { providerId: BUILTIN_DEEPSEEK_ID, modelId },
    }
  }

  const normalizedBase =
    normalizeProviderBaseUrl(legacy.endpoint) ??
    chatBaseUrl(legacy.endpoint, legacy.format)?.replace(/\/+$/, '') ??
    legacy.endpoint.trim().replace(/\/+$/, '')
  const modelId = legacyModel || DEFAULT_CHAT_MODEL
  const matched = providers.find(
    (provider) => !provider.builtin && matchesProviderBaseUrl(provider.baseUrl, normalizedBase, legacy.format)
  )

  if (matched) {
    const updated = providers.map((provider) =>
      provider.id === matched.id
        ? {
            ...provider,
            enabled: true,
            format: legacy.format,
            baseUrl: normalizedBase || provider.baseUrl,
            apiKey: legacy.apiKey.trim(),
            models: upsertEnabledModel(provider.models, modelId),
          }
        : provider
    )
    return {
      providers: updated,
      activeModel: { providerId: matched.id, modelId },
    }
  }

  let hostname = '自定义服务'
  try {
    hostname = new URL(normalizedBase).hostname || hostname
  } catch {
    // 保留回退名称
  }
  const customProvider: ModelProviderConfig = {
    id: 'migrated-custom',
    name: hostname,
    format: legacy.format,
    baseUrl: normalizedBase,
    apiKey: legacy.apiKey.trim(),
    enabled: true,
    models: [
      {
        id: modelId,
        label: modelId,
        group: inferModelGroup(modelId),
        enabled: true,
      },
    ],
  }

  return {
    providers: [...providers, customProvider],
    activeModel: { providerId: customProvider.id, modelId },
  }
}

export const resolveActiveRef = (
  providers: readonly ModelProviderConfig[],
  preferred?: ActiveModelRef | null
): ActiveModelRef => {
  if (preferred) {
    const provider = providers.find((item) => item.id === preferred.providerId && item.enabled)
    const model = provider?.models.find((item) => item.id === preferred.modelId && item.enabled)
    if (provider && model) {
      return { providerId: provider.id, modelId: model.id }
    }
  }

  const deepSeek = providers.find((item) => item.id === BUILTIN_DEEPSEEK_ID && item.enabled)
  const deepSeekModel = deepSeek?.models.find((item) => item.enabled)
  if (deepSeek && deepSeekModel) {
    return { providerId: deepSeek.id, modelId: deepSeekModel.id }
  }

  for (const provider of providers) {
    if (!provider.enabled) {
      continue
    }
    const model = provider.models.find((item) => item.enabled)
    if (model) {
      return { providerId: provider.id, modelId: model.id }
    }
  }

  return { providerId: BUILTIN_DEEPSEEK_ID, modelId: DEFAULT_CHAT_MODEL }
}

export const resolveChatConfigFromProviders = (
  providers: readonly ModelProviderConfig[],
  activeModel: ActiveModelRef,
  previous: ChatConfig = DEFAULT_CHAT_CONFIG
): ChatConfig => {
  const resolvedRef = resolveActiveRef(providers, activeModel)
  const provider = providers.find((item) => item.id === resolvedRef.providerId)
  if (!provider || provider.builtin) {
    return {
      model: resolvedRef.modelId || DEFAULT_CHAT_MODEL,
      endpoint: '',
      format: provider?.format ?? 'messages',
      apiKey: '',
    }
  }
  const endpoint = resolveChatEndpoint(provider.baseUrl, provider.format, previous) ?? ''
  return {
    model: resolvedRef.modelId || DEFAULT_CHAT_MODEL,
    endpoint,
    format: provider.format,
    apiKey: endpoint ? provider.apiKey.trim() : '',
  }
}

const sameChatConfig = (a: ChatConfig, b: ChatConfig): boolean =>
  a.model === b.model &&
  a.endpoint === b.endpoint &&
  a.format === b.format &&
  a.apiKey === b.apiKey

const syncRuntimeChatConfig = (
  providers: readonly ModelProviderConfig[],
  activeModel: ActiveModelRef
): boolean => {
  const current = useSettings.getState().chatConfig
  const next = resolveChatConfigFromProviders(providers, activeModel, current)
  if (sameChatConfig(current, next)) {
    return true
  }
  return setChatConfig(next)
}

const loadInitialState = (): {
  providers: ModelProviderConfig[]
  activeModel: ActiveModelRef
} => {
  const rawProviders = readStorage(PROVIDERS_STORAGE_KEY)
  if (rawProviders) {
    try {
      const parsed: unknown = JSON.parse(rawProviders)
      if (Array.isArray(parsed)) {
        const secrets = readProviderSecrets()
        const loaded = ensureBuiltinProvider(
          parsed
            .map((item) => normalizeProvider(item, secrets))
            .filter((item): item is ModelProviderConfig => item !== null)
        )
        let storedActive: ActiveModelRef | null = null
        try {
          const activeRaw = readStorage(ACTIVE_MODEL_STORAGE_KEY)
          const parsedActive: unknown = activeRaw ? JSON.parse(activeRaw) : null
          if (
            parsedActive &&
            typeof parsedActive === 'object' &&
            typeof (parsedActive as Record<string, unknown>).providerId === 'string' &&
            typeof (parsedActive as Record<string, unknown>).modelId === 'string'
          ) {
            storedActive = {
              providerId: (parsedActive as Record<string, string>).providerId,
              modelId: (parsedActive as Record<string, string>).modelId,
            }
          }
        } catch {
          storedActive = null
        }
        // 旧版本激活的是已退役的 deepseek-pro，升级到 V4 后落到 deepseek-v4-pro。
        if (
          storedActive &&
          storedActive.providerId === BUILTIN_DEEPSEEK_ID &&
          storedActive.modelId === 'deepseek-pro'
        ) {
          storedActive = { providerId: BUILTIN_DEEPSEEK_ID, modelId: 'deepseek-v4-pro' }
        }
        const activeModel = resolveActiveRef(loaded, storedActive)
        return { providers: loaded, activeModel }
      }
    } catch {
      // 存储损坏时回退旧配置迁移
    }
  }
  const migrated = migrateLegacyChatConfig(useSettings.getState().chatConfig)
  persistState(migrated.providers, migrated.activeModel)
  return migrated
}

type ModelProvidersState = {
  providers: ModelProviderConfig[]
  activeModel: ActiveModelRef
}

const initialState = loadInitialState()

export const useModelProviders = create<ModelProvidersState>(() => initialState)

const commitState = (providers: ModelProviderConfig[], preferredActive?: ActiveModelRef) => {
  const activeModel = resolveActiveRef(providers, preferredActive ?? useModelProviders.getState().activeModel)
  persistState(providers, activeModel)
  syncRuntimeChatConfig(providers, activeModel)
  useModelProviders.setState({ providers, activeModel })
}

export const getActiveProviderAndModel = (
  state: ModelProvidersState = useModelProviders.getState()
): { provider: ModelProviderConfig; model: ProviderModelItem | null } => {
  const ref = resolveActiveRef(state.providers, state.activeModel)
  const provider =
    state.providers.find((item) => item.id === ref.providerId) ??
    state.providers[0] ??
    createDefaultProviders()[0]
  const model = provider.models.find((item) => item.id === ref.modelId) ?? null
  return { provider, model }
}

export const getActiveModelContextWindow = (): number | undefined => {
  const { model } = getActiveProviderAndModel()
  return model?.contextWindow
}

export type EnabledModelGroup = {
  provider: ModelProviderConfig
  models: ProviderModelItem[]
}

export const getEnabledModelGroups = (
  providers: readonly ModelProviderConfig[]
): EnabledModelGroup[] =>
  providers
    .filter((provider) => provider.enabled)
    .map((provider) => ({
      provider,
      models: provider.models.filter((model) => model.enabled),
    }))
    .filter((group) => group.models.length > 0)

export const selectActiveModel = (ref: ActiveModelRef): boolean => {
  const { providers } = useModelProviders.getState()
  const provider = providers.find((item) => item.id === ref.providerId && item.enabled)
  const model = provider?.models.find((item) => item.id === ref.modelId && item.enabled)
  if (!provider || !model) {
    return false
  }
  const nextRef: ActiveModelRef = { providerId: provider.id, modelId: model.id }
  persistState(providers, nextRef)
  syncRuntimeChatConfig(providers, nextRef)
  useModelProviders.setState({ activeModel: nextRef })
  return true
}

export const syncActiveModelForSession = (ref?: ActiveModelRef): boolean => {
  if (!ref) {
    return false
  }
  return selectActiveModel(ref)
}

export const setProviderEnabled = (providerId: string, enabled: boolean) => {
  const { providers, activeModel } = useModelProviders.getState()
  const target = providers.find((item) => item.id === providerId)
  if (!target || target.enabled === enabled) {
    return
  }
  // 不允许将所有有可用模型的供应商全部关闭到零可用状态时静默回退
  const next = providers.map((item) =>
    item.id === providerId ? { ...item, enabled } : item
  )
  const hasAnyEnabled = next.some((p) => p.enabled && p.models.some((m) => m.enabled))
  if (!enabled && !hasAnyEnabled && target.builtin) {
    return
  }
  commitState(next, activeModel)
}

export const updateProvider = (
  providerId: string,
  patch: Partial<Pick<ModelProviderConfig, 'name' | 'format' | 'baseUrl' | 'apiKey' | 'enabled'>>
) => {
  const { providers, activeModel } = useModelProviders.getState()
  const next = providers.map((provider) => {
    if (provider.id !== providerId) {
      return provider
    }
    if (provider.builtin) {
      return {
        ...provider,
        ...(patch.format !== undefined ? { format: patch.format } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      }
    }
    const nextFormat = patch.format ?? provider.format
    const nextBaseUrl =
      patch.baseUrl !== undefined
        ? (normalizeProviderBaseUrl(patch.baseUrl) ?? patch.baseUrl.trim())
        : provider.baseUrl
    return {
      ...provider,
      ...(patch.name !== undefined ? { name: patch.name.trim() || provider.name } : {}),
      format: nextFormat,
      baseUrl: nextBaseUrl,
      ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey.trim() } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    }
  })
  commitState(next, activeModel)
}

export const addCustomProvider = (input: {
  name: string
  format: ChatApiFormat
  baseUrl: string
  apiKey: string
}): ModelProviderConfig | null => {
  const name = input.name.trim()
  const baseUrl = normalizeProviderBaseUrl(input.baseUrl)
  if (!name || !baseUrl) {
    return null
  }
  const created: ModelProviderConfig = {
    id: `provider-${createId()}`,
    name,
    format: input.format,
    baseUrl,
    apiKey: input.apiKey.trim(),
    enabled: true,
    models: [],
  }
  const { providers, activeModel } = useModelProviders.getState()
  commitState([...providers, created], activeModel)
  return created
}

export const removeCustomProvider = (providerId: string): boolean => {
  const { providers, activeModel } = useModelProviders.getState()
  const target = providers.find((item) => item.id === providerId)
  if (!target || target.builtin) {
    return false
  }
  const next = providers.filter((item) => item.id !== providerId)
  commitState(next, activeModel)
  return true
}

export const toggleProviderModel = (
  providerId: string,
  modelId: string,
  forcedEnabled?: boolean
) => {
  const { providers, activeModel } = useModelProviders.getState()
  const targetProvider = providers.find((item) => item.id === providerId)
  if (!targetProvider) {
    return
  }
  let enabledResult = false
  let shouldAutoEnableProvider = false
  const next = providers.map((provider) => {
    if (provider.id !== providerId) {
      return provider
    }
    const models = provider.models.map((model) => {
      if (model.id !== modelId) {
        return model
      }
      enabledResult = forcedEnabled ?? !model.enabled
      return { ...model, enabled: enabledResult }
    })
    if (
      enabledResult &&
      !provider.builtin &&
      !provider.enabled &&
      Boolean(provider.baseUrl.trim())
    ) {
      shouldAutoEnableProvider = true
    }
    return {
      ...provider,
      ...(shouldAutoEnableProvider ? { enabled: true } : {}),
      models,
    }
  })

  const officialKeyMissing = !useSettings.getState().apiKey
  const shouldAutoActivate =
    enabledResult &&
    !targetProvider.builtin &&
    officialKeyMissing &&
    activeModel.providerId === BUILTIN_DEEPSEEK_ID
  commitState(
    next,
    shouldAutoActivate ? { providerId, modelId } : activeModel
  )
}

export const addManualModel = (
  providerId: string,
  input: { id: string; label?: string; contextWindow?: number }
): boolean => {
  const modelId = input.id.trim()
  if (!modelId) {
    return false
  }
  const label = input.label?.trim() || modelId
  const contextWindow =
    typeof input.contextWindow === 'number' &&
    Number.isSafeInteger(input.contextWindow) &&
    input.contextWindow >= 1024
      ? input.contextWindow
      : undefined
  const { providers, activeModel } = useModelProviders.getState()
  const targetProvider = providers.find((item) => item.id === providerId)
  if (!targetProvider) {
    return false
  }

  const next = providers.map((provider) => {
    if (provider.id !== providerId) {
      return provider
    }
    const existingIndex = provider.models.findIndex((item) => item.id === modelId)
    const models =
      existingIndex >= 0
        ? provider.models.map((item, idx) =>
            idx === existingIndex
              ? {
                  ...item,
                  label,
                  enabled: true,
                  ...(contextWindow !== undefined ? { contextWindow } : {}),
                }
              : item
          )
        : [
            ...provider.models,
            {
              id: modelId,
              label,
              group: inferModelGroup(modelId),
              enabled: true,
              ...(contextWindow !== undefined ? { contextWindow } : {}),
            },
          ]
    return {
      ...provider,
      ...(!provider.builtin && !provider.enabled && Boolean(provider.baseUrl.trim())
        ? { enabled: true }
        : {}),
      models,
    }
  })

  const officialKeyMissing = !useSettings.getState().apiKey
  const shouldAutoActivate =
    !targetProvider.builtin &&
    officialKeyMissing &&
    activeModel.providerId === BUILTIN_DEEPSEEK_ID
  commitState(
    next,
    shouldAutoActivate ? { providerId, modelId } : activeModel
  )
  return true
}

export const mergeProviderModels = (
  providerId: string,
  fetched: readonly ParsedRemoteModel[]
) => {
  const { providers, activeModel } = useModelProviders.getState()
  const next = providers.map((provider) =>
    provider.id === providerId
      ? { ...provider, models: mergeFetchedModels(provider.models, fetched) }
      : provider
  )
  commitState(next, activeModel)
}
