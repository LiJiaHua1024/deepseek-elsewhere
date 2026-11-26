export type TtsProviderId = 'edge' | 'deepseek' | 'openai' | 'system'

export type AsrProviderId = 'deepseek' | 'openai' | 'system'

export type AsrLanguage = 'auto' | 'zh' | 'en' | 'ja'

export type OpenAiTtsPresetId = 'siliconflow' | 'openrouter' | 'openai' | 'groq' | 'custom'

export type OpenAiAsrPresetId = 'siliconflow' | 'groq' | 'openai' | 'custom'

export type VoiceConfig = {
  ttsProvider: TtsProviderId
  edgeVoiceId: string
  edgeSpeed: number
  openaiTts: {
    presetId: OpenAiTtsPresetId
    baseUrl: string
    model: string
    voice: string
    speed: number
  }
  systemTts: {
    voiceId: string
    speed: number
  }
  asrProvider: AsrProviderId
  openaiAsr: {
    presetId: OpenAiAsrPresetId
    baseUrl: string
    model: string
    language: AsrLanguage
  }
  systemAsrLanguage: AsrLanguage
}

export type VoiceSecrets = {
  ttsApiKey: string
  asrApiKey: string
}

export type VoiceLangFilter = 'all' | 'zh' | 'en' | 'ja'

export type EdgeVoiceItem = {
  id: string
  name: string
  lang: 'zh' | 'en' | 'ja' | 'other'
  meta: string
  locale: string
  gender: string
}

export type SystemVoiceItem = {
  id: string
  name: string
  locale: string
  lang: 'zh' | 'en' | 'ja' | 'other'
  meta: string
  network?: boolean
}

export type OpenAiTtsPreset = {
  id: OpenAiTtsPresetId
  label: string
  labelEn: string
  baseUrl: string
  model: string
  voice: string
  voices?: readonly string[]
}

export type OpenAiAsrPreset = {
  id: OpenAiAsrPresetId
  label: string
  labelEn: string
  baseUrl: string
  model: string
}
