import { create } from 'zustand'
import { android } from '../../app/android.js'
import type { TtsVoice } from '../../services/api/speech.js'
import { useModelProviders } from '../models/config.js'
import { normalizeProviderBaseUrl } from '../models/fetchModels.js'
import type { ModelProviderConfig } from '../models/types.js'
import type {
  AsrLanguage,
  AsrProviderId,
  OpenAiAsrPreset,
  OpenAiAsrPresetId,
  OpenAiTtsPreset,
  OpenAiTtsPresetId,
  TtsProviderId,
  VoiceConfig,
  VoiceSecrets,
} from './types.js'

export const VOICE_CONFIG_STORAGE_KEY = 'elsewhere:voice-config-v1'
export const VOICE_SECRETS_STORAGE_KEY = 'elsewhere:voice-secrets-v1'

export const DEFAULT_EDGE_VOICE_ID = 'zh-CN-XiaoxiaoNeural'

export const SILICONFLOW_COSYVOICE_VOICES = [
  'alex',
  'anna',
  'bella',
  'benjamin',
  'charles',
  'claire',
  'david',
  'diana',
] as const

export const OPENAI_TTS_PRESETS: Record<OpenAiTtsPresetId, OpenAiTtsPreset> = {
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    labelEn: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/CosyVoice2-0.5B',
    voice: 'FunAudioLLM/CosyVoice2-0.5B:alex',
    voices: SILICONFLOW_COSYVOICE_VOICES,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    labelEn: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-3.8-flash-lite-tts',
    voice: 'Kore',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    labelEn: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'coral',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    labelEn: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'canopylabs/orpheus-v1-english',
    voice: 'autumn',
  },
  custom: {
    id: 'custom',
    label: '自定义',
    labelEn: 'Custom',
    baseUrl: '',
    model: 'tts-1',
    voice: 'alloy',
  },
}

export const OPENAI_ASR_PRESETS: Record<OpenAiAsrPresetId, OpenAiAsrPreset> = {
  siliconflow: {
    id: 'siliconflow',
    label: '硅基流动',
    labelEn: 'SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'FunAudioLLM/SenseVoiceSmall',
  },
  groq: {
    id: 'groq',
    label: 'Groq',
    labelEn: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    labelEn: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
  },
  custom: {
    id: 'custom',
    label: '自定义',
    labelEn: 'Custom',
    baseUrl: '',
    model: 'whisper-1',
  },
}

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

const readDeepSeekKeyFromStorage = (): string => {
  try {
    if (android?.readApiKey) {
      return android.readApiKey()?.trim() ?? ''
    }
    return readStorage('chat-demo:api-key')?.trim() ?? ''
  } catch {
    return ''
  }
}

export const isDesktopSpeechRecognitionAvailable = (): boolean => {
  if (typeof window === 'undefined') {
    return false
  }
  const win = window as Window & {
    SpeechRecognition?: unknown
    webkitSpeechRecognition?: unknown
  }
  return Boolean(win.SpeechRecognition || win.webkitSpeechRecognition)
}

export const isSystemAsrSupported = (): boolean => {
  if (android?.isSystemAsrAvailable) {
    try {
      return Boolean(android.isSystemAsrAvailable())
    } catch {
      return false
    }
  }
  return isDesktopSpeechRecognitionAvailable()
}

export const isSystemTtsSupported = (): boolean => {
  if (android?.speakSystemTts) {
    return true
  }
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export const normalizeVoiceBaseUrl = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  const stripped = trimmed.replace(/\/+$/, '').replace(/\/audio\/(speech|transcriptions)$/i, '')
  return normalizeProviderBaseUrl(stripped) ?? stripped.replace(/\/+$/, '')
}

const appendV1Path = (baseUrl: string, suffix: string): string | null => {
  const normalized = normalizeVoiceBaseUrl(baseUrl)
  if (!normalized || !/^https?:\/\//i.test(normalized)) {
    return null
  }
  try {
    const url = new URL(normalized)
    const path = url.pathname.replace(/\/+$/, '')
    const version = path.endsWith('/v1') ? '' : '/v1'
    url.pathname = `${path}${version}${suffix}`
    return url.href
  } catch {
    return null
  }
}

export const buildAudioSpeechUrl = (baseUrl: string): string | null =>
  appendV1Path(baseUrl, '/audio/speech')

export const buildAudioTranscriptionsUrl = (baseUrl: string): string | null =>
  appendV1Path(baseUrl, '/audio/transcriptions')

export const buildOpenRouterSpeechModelsUrl = (baseUrl: string): string | null =>
  appendV1Path(baseUrl, '/audio/speech/models')

export const isOpenRouterUrl = (baseUrl: string): boolean => {
  const normalized = normalizeVoiceBaseUrl(baseUrl)
  if (!normalized) {
    return false
  }
  try {
    const host = new URL(normalized).hostname.toLowerCase()
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

export const clampSpeed = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return 1.0
  }
  const rounded = Math.round(value * 10) / 10
  return Math.min(max, Math.max(min, rounded))
}

export const resolveDefaultVoiceConfig = (env: {
  hasDeepSeekKey: boolean
  isAndroid: boolean
  systemAsrAvailable: boolean
}): VoiceConfig => ({
  ttsProvider: env.hasDeepSeekKey ? 'deepseek' : env.isAndroid ? 'edge' : 'system',
  edgeVoiceId: DEFAULT_EDGE_VOICE_ID,
  edgeSpeed: 1.0,
  openaiTts: {
    presetId: 'siliconflow',
    baseUrl: OPENAI_TTS_PRESETS.siliconflow.baseUrl,
    model: OPENAI_TTS_PRESETS.siliconflow.model,
    voice: OPENAI_TTS_PRESETS.siliconflow.voice,
    speed: 1.0,
  },
  systemTts: {
    voiceId: '',
    speed: 1.0,
  },
  asrProvider: env.hasDeepSeekKey ? 'deepseek' : env.systemAsrAvailable ? 'system' : 'openai',
  openaiAsr: {
    presetId: 'siliconflow',
    baseUrl: OPENAI_ASR_PRESETS.siliconflow.baseUrl,
    model: OPENAI_ASR_PRESETS.siliconflow.model,
    language: 'auto',
  },
  systemAsrLanguage: 'auto',
})

const isTtsProviderId = (value: unknown, isAndroid: boolean): value is TtsProviderId =>
  value === 'deepseek' ||
  value === 'openai' ||
  value === 'system' ||
  (value === 'edge' && isAndroid)

const isAsrProviderId = (value: unknown): value is AsrProviderId =>
  value === 'deepseek' || value === 'openai' || value === 'system'

const isAsrLanguage = (value: unknown): value is AsrLanguage =>
  value === 'auto' || value === 'zh' || value === 'en' || value === 'ja'

const isOpenAiTtsPresetId = (value: unknown): value is OpenAiTtsPresetId =>
  typeof value === 'string' && Object.hasOwn(OPENAI_TTS_PRESETS, value)

const isOpenAiAsrPresetId = (value: unknown): value is OpenAiAsrPresetId =>
  typeof value === 'string' && Object.hasOwn(OPENAI_ASR_PRESETS, value)

const normalizeConfig = (raw: unknown, fallback: VoiceConfig, isAndroid: boolean): VoiceConfig => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return fallback
  }
  const obj = raw as Record<string, unknown>
  const rawOpenAiTts =
    obj.openaiTts && typeof obj.openaiTts === 'object'
      ? (obj.openaiTts as Record<string, unknown>)
      : {}
  const rawSysTts =
    obj.systemTts && typeof obj.systemTts === 'object'
      ? (obj.systemTts as Record<string, unknown>)
      : {}
  const rawOpenAiAsr =
    obj.openaiAsr && typeof obj.openaiAsr === 'object'
      ? (obj.openaiAsr as Record<string, unknown>)
      : {}

  return {
    ttsProvider: isTtsProviderId(obj.ttsProvider, isAndroid)
      ? obj.ttsProvider
      : fallback.ttsProvider,
    edgeVoiceId:
      typeof obj.edgeVoiceId === 'string' && obj.edgeVoiceId.trim()
        ? obj.edgeVoiceId.trim()
        : fallback.edgeVoiceId,
    edgeSpeed:
      typeof obj.edgeSpeed === 'number' ? clampSpeed(obj.edgeSpeed, 0.7, 2.0) : fallback.edgeSpeed,
    openaiTts: {
      presetId: isOpenAiTtsPresetId(rawOpenAiTts.presetId)
        ? rawOpenAiTts.presetId
        : fallback.openaiTts.presetId,
      baseUrl:
        typeof rawOpenAiTts.baseUrl === 'string'
          ? rawOpenAiTts.baseUrl.trim()
          : fallback.openaiTts.baseUrl,
      model:
        typeof rawOpenAiTts.model === 'string'
          ? rawOpenAiTts.model.trim()
          : fallback.openaiTts.model,
      voice:
        typeof rawOpenAiTts.voice === 'string'
          ? rawOpenAiTts.voice.trim()
          : fallback.openaiTts.voice,
      speed:
        typeof rawOpenAiTts.speed === 'number'
          ? clampSpeed(rawOpenAiTts.speed, 0.5, 2.0)
          : fallback.openaiTts.speed,
    },
    systemTts: {
      voiceId:
        typeof rawSysTts.voiceId === 'string' ? rawSysTts.voiceId : fallback.systemTts.voiceId,
      speed:
        typeof rawSysTts.speed === 'number'
          ? clampSpeed(rawSysTts.speed, 0.7, 2.0)
          : fallback.systemTts.speed,
    },
    asrProvider: isAsrProviderId(obj.asrProvider) ? obj.asrProvider : fallback.asrProvider,
    openaiAsr: {
      presetId: isOpenAiAsrPresetId(rawOpenAiAsr.presetId)
        ? rawOpenAiAsr.presetId
        : fallback.openaiAsr.presetId,
      baseUrl:
        typeof rawOpenAiAsr.baseUrl === 'string'
          ? rawOpenAiAsr.baseUrl.trim()
          : fallback.openaiAsr.baseUrl,
      model:
        typeof rawOpenAiAsr.model === 'string'
          ? rawOpenAiAsr.model.trim()
          : fallback.openaiAsr.model,
      language: isAsrLanguage(rawOpenAiAsr.language)
        ? rawOpenAiAsr.language
        : fallback.openaiAsr.language,
    },
    systemAsrLanguage: isAsrLanguage(obj.systemAsrLanguage)
      ? obj.systemAsrLanguage
      : fallback.systemAsrLanguage,
  }
}

const loadSecrets = (): VoiceSecrets => {
  try {
    const raw = android?.readVoiceSecrets
      ? android.readVoiceSecrets()
      : readStorage(VOICE_SECRETS_STORAGE_KEY)
    if (!raw) {
      return { ttsApiKey: '', asrApiKey: '' }
    }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ttsApiKey: '', asrApiKey: '' }
    }
    const obj = parsed as Record<string, unknown>
    return {
      ttsApiKey: typeof obj.ttsApiKey === 'string' ? obj.ttsApiKey : '',
      asrApiKey: typeof obj.asrApiKey === 'string' ? obj.asrApiKey : '',
    }
  } catch {
    return { ttsApiKey: '', asrApiKey: '' }
  }
}

const persistSecrets = (secrets: VoiceSecrets): boolean => {
  const clean: VoiceSecrets = {
    ttsApiKey: secrets.ttsApiKey.trim(),
    asrApiKey: secrets.asrApiKey.trim(),
  }
  const serialized = clean.ttsApiKey || clean.asrApiKey ? JSON.stringify(clean) : null
  if (android?.writeVoiceSecrets) {
    return android.writeVoiceSecrets(serialized)
  }
  return writeStorage(VOICE_SECRETS_STORAGE_KEY, serialized)
}

const loadInitialVoiceConfig = (): VoiceConfig => {
  const isAndroid = Boolean(android)
  const fallback = resolveDefaultVoiceConfig({
    hasDeepSeekKey: Boolean(readDeepSeekKeyFromStorage()),
    isAndroid,
    systemAsrAvailable: isSystemAsrSupported(),
  })
  const raw = readStorage(VOICE_CONFIG_STORAGE_KEY)
  if (!raw) {
    writeStorage(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return normalizeConfig(JSON.parse(raw), fallback, isAndroid)
  } catch {
    return fallback
  }
}

type VoiceStoreState = {
  config: VoiceConfig
  secrets: VoiceSecrets
}

export const useVoiceConfig = create<VoiceStoreState>(() => ({
  config: loadInitialVoiceConfig(),
  secrets: loadSecrets(),
}))

const updateConfig = (updater: (current: VoiceConfig) => VoiceConfig) => {
  const next = updater(useVoiceConfig.getState().config)
  writeStorage(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(next))
  useVoiceConfig.setState({ config: next })
}

const updateSecrets = (patch: Partial<VoiceSecrets>) => {
  const current = useVoiceConfig.getState().secrets
  const next: VoiceSecrets = {
    ttsApiKey: patch.ttsApiKey !== undefined ? patch.ttsApiKey.trim() : current.ttsApiKey,
    asrApiKey: patch.asrApiKey !== undefined ? patch.asrApiKey.trim() : current.asrApiKey,
  }
  persistSecrets(next)
  useVoiceConfig.setState({ secrets: next })
}

export const setTtsProvider = (ttsProvider: TtsProviderId) => {
  updateConfig((current) => ({ ...current, ttsProvider }))
}

export const setEdgeVoiceId = (edgeVoiceId: string) => {
  updateConfig((current) => ({
    ...current,
    edgeVoiceId: edgeVoiceId.trim() || DEFAULT_EDGE_VOICE_ID,
  }))
}

export const setEdgeSpeed = (edgeSpeed: number) => {
  updateConfig((current) => ({ ...current, edgeSpeed: clampSpeed(edgeSpeed, 0.7, 2.0) }))
}

export const applyOpenAiTtsPreset = (presetId: OpenAiTtsPresetId) => {
  const preset = OPENAI_TTS_PRESETS[presetId]
  updateConfig((current) => ({
    ...current,
    openaiTts: {
      ...current.openaiTts,
      presetId,
      baseUrl: preset.baseUrl || (presetId === 'custom' ? current.openaiTts.baseUrl : ''),
      model: preset.model,
      voice: preset.voice,
    },
  }))
}

export const updateOpenAiTts = (
  patch: Partial<Omit<VoiceConfig['openaiTts'], 'presetId'>> & { presetId?: OpenAiTtsPresetId }
) => {
  updateConfig((current) => ({
    ...current,
    openaiTts: {
      ...current.openaiTts,
      ...patch,
      ...(patch.speed !== undefined ? { speed: clampSpeed(patch.speed, 0.5, 2.0) } : {}),
    },
  }))
}

export const setTtsApiKey = (ttsApiKey: string) => {
  updateSecrets({ ttsApiKey })
}

export const setSystemTtsVoiceId = (voiceId: string) => {
  updateConfig((current) => ({
    ...current,
    systemTts: { ...current.systemTts, voiceId },
  }))
}

export const setSystemTtsSpeed = (speed: number) => {
  updateConfig((current) => ({
    ...current,
    systemTts: { ...current.systemTts, speed: clampSpeed(speed, 0.7, 2.0) },
  }))
}

export const setAsrProvider = (asrProvider: AsrProviderId) => {
  updateConfig((current) => ({ ...current, asrProvider }))
}

export const applyOpenAiAsrPreset = (presetId: OpenAiAsrPresetId) => {
  const preset = OPENAI_ASR_PRESETS[presetId]
  updateConfig((current) => ({
    ...current,
    openaiAsr: {
      ...current.openaiAsr,
      presetId,
      baseUrl: preset.baseUrl || (presetId === 'custom' ? current.openaiAsr.baseUrl : ''),
      model: preset.model,
    },
  }))
}

export const updateOpenAiAsr = (
  patch: Partial<Omit<VoiceConfig['openaiAsr'], 'presetId'>> & { presetId?: OpenAiAsrPresetId }
) => {
  updateConfig((current) => ({
    ...current,
    openaiAsr: {
      ...current.openaiAsr,
      ...patch,
    },
  }))
}

export const setAsrApiKey = (asrApiKey: string) => {
  updateSecrets({ asrApiKey })
}

export const setSystemAsrLanguage = (systemAsrLanguage: AsrLanguage) => {
  updateConfig((current) => ({ ...current, systemAsrLanguage }))
}

export const getImportableModelProviders = (): ModelProviderConfig[] =>
  useModelProviders
    .getState()
    .providers.filter((item) => !item.builtin && Boolean(item.baseUrl.trim()))

const matchTtsPresetByUrl = (baseUrl: string): OpenAiTtsPresetId => {
  const lower = normalizeVoiceBaseUrl(baseUrl).toLowerCase()
  if (lower.includes('siliconflow')) {
    return 'siliconflow'
  }
  if (lower.includes('openrouter.ai')) {
    return 'openrouter'
  }
  if (lower.includes('api.openai.com')) {
    return 'openai'
  }
  if (lower.includes('api.groq.com')) {
    return 'groq'
  }
  return 'custom'
}

const matchAsrPresetByUrl = (baseUrl: string): OpenAiAsrPresetId => {
  const lower = normalizeVoiceBaseUrl(baseUrl).toLowerCase()
  if (lower.includes('siliconflow')) {
    return 'siliconflow'
  }
  if (lower.includes('api.groq.com')) {
    return 'groq'
  }
  if (lower.includes('api.openai.com')) {
    return 'openai'
  }
  return 'custom'
}

export const importModelProviderForTts = (provider: ModelProviderConfig) => {
  const presetId = matchTtsPresetByUrl(provider.baseUrl)
  const preset = OPENAI_TTS_PRESETS[presetId]
  const baseUrl = normalizeVoiceBaseUrl(provider.baseUrl) || provider.baseUrl.trim()
  updateConfig((current) => ({
    ...current,
    openaiTts: {
      ...current.openaiTts,
      presetId,
      baseUrl,
      model: presetId === 'custom' ? current.openaiTts.model || preset.model : preset.model,
      voice: presetId === 'custom' ? current.openaiTts.voice || preset.voice : preset.voice,
    },
  }))
  if (provider.apiKey.trim()) {
    setTtsApiKey(provider.apiKey.trim())
  }
}

export const importModelProviderForAsr = (provider: ModelProviderConfig) => {
  const presetId = matchAsrPresetByUrl(provider.baseUrl)
  const preset = OPENAI_ASR_PRESETS[presetId]
  const baseUrl = normalizeVoiceBaseUrl(provider.baseUrl) || provider.baseUrl.trim()
  updateConfig((current) => ({
    ...current,
    openaiAsr: {
      ...current.openaiAsr,
      presetId,
      baseUrl,
      model: presetId === 'custom' ? current.openaiAsr.model || preset.model : preset.model,
    },
  }))
  if (provider.apiKey.trim()) {
    setAsrApiKey(provider.apiKey.trim())
  }
}

export const isTtsReady = (
  config: VoiceConfig,
  deepSeekApiKey: string | null | undefined,
  ttsApiKey?: string | null,
  env?: { isAndroid?: boolean; systemTtsAvailable?: boolean }
): boolean => {
  const isAndroid = env?.isAndroid ?? Boolean(android)
  const systemAvailable = env?.systemTtsAvailable ?? isSystemTtsSupported()
  switch (config.ttsProvider) {
    case 'edge':
      return isAndroid
    case 'deepseek':
      return Boolean(deepSeekApiKey?.trim())
    case 'openai':
      return Boolean(
        buildAudioSpeechUrl(config.openaiTts.baseUrl) &&
        config.openaiTts.model.trim() &&
        config.openaiTts.voice.trim() &&
        (ttsApiKey ?? useVoiceConfig.getState().secrets.ttsApiKey).trim()
      )
    case 'system':
      return systemAvailable
  }
}

export const isAsrReady = (
  config: VoiceConfig,
  deepSeekApiKey: string | null | undefined,
  asrApiKey?: string | null,
  env?: { systemAsrAvailable?: boolean }
): boolean => {
  const systemAvailable = env?.systemAsrAvailable ?? isSystemAsrSupported()
  switch (config.asrProvider) {
    case 'deepseek':
      return Boolean(deepSeekApiKey?.trim())
    case 'openai':
      return Boolean(
        buildAudioTranscriptionsUrl(config.openaiAsr.baseUrl) &&
        config.openaiAsr.model.trim() &&
        (asrApiKey ?? useVoiceConfig.getState().secrets.asrApiKey).trim()
      )
    case 'system':
      return systemAvailable
  }
}

export const getAsrSummaryLabel = (config: VoiceConfig, zh: boolean): string => {
  switch (config.asrProvider) {
    case 'deepseek':
      return 'DeepSeek'
    case 'system':
      return zh ? '系统识别' : 'System'
    case 'openai': {
      const preset = OPENAI_ASR_PRESETS[config.openaiAsr.presetId]
      return config.openaiAsr.presetId === 'custom'
        ? zh
          ? 'OpenAI 兼容'
          : 'OpenAI-compatible'
        : zh
          ? preset.label
          : preset.labelEn
    }
  }
}

export const getDeepSeekVoiceLabel = (voice: TtsVoice, zh: boolean): string =>
  voice === 'tide' ? (zh ? '暗潮' : 'Tide') : zh ? '海星' : 'Stella'
