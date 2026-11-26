import { android, uploadAndroidAsrAudio } from '../../app/android.js'
import { ApiError } from '../../services/api/client.js'
import { transcribe as transcribeWithDeepSeek } from '../../services/api/speech.js'
import { useSettings } from '../../services/settings.js'
import { buildAudioTranscriptionsUrl, useVoiceConfig } from './config.js'
import { VoiceConfigError } from './tts.js'
import type { AsrLanguage } from './types.js'

export const asrLanguageToBcp47 = (lang: AsrLanguage): string => {
  switch (lang) {
    case 'zh':
      return 'zh-CN'
    case 'en':
      return 'en-US'
    case 'ja':
      return 'ja-JP'
    case 'auto':
      return ''
  }
}

export const parseAsrResponseText = (raw: string, contentType = ''): string => {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }
  const lowerCt = contentType.toLowerCase()
  if (lowerCt.includes('text/plain') && !trimmed.startsWith('{')) {
    return trimmed
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') {
      return parsed.trim()
    }
    if (parsed && typeof parsed === 'object') {
      const obj = parsed as Record<string, unknown>
      if (typeof obj.text === 'string') {
        return obj.text.trim()
      }
      if (obj.data && typeof obj.data === 'object') {
        const nested = obj.data as Record<string, unknown>
        if (typeof nested.text === 'string') {
          return nested.text.trim()
        }
      }
    }
  } catch {
    if (!trimmed.startsWith('<')) {
      return trimmed
    }
  }
  throw new ApiError('protocol', raw)
}

export const transcribeWithOpenAi = async (options: {
  baseUrl: string
  apiKey: string
  model: string
  language: AsrLanguage
  audio?: Blob
  signal?: AbortSignal
}): Promise<string> => {
  const url = buildAudioTranscriptionsUrl(options.baseUrl)
  const model = options.model.trim()
  const apiKey = options.apiKey.trim()
  if (!url || !model || !apiKey) {
    throw new VoiceConfigError('missingOpenAiConfig', '请先完善语音输入接口配置')
  }

  const fields: Record<string, string> = { model }
  if (options.language !== 'auto') {
    fields.language = options.language
  }

  if (android?.beginAsrUpload && !options.audio) {
    const response = await uploadAndroidAsrAudio(
      {
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
        fields,
        fileField: 'file',
        fileName: 'recording.wav',
        fileMime: 'audio/wav',
        timeoutMs: 60_000,
      },
      options.signal
    )
    if (!response.ok) {
      throw new ApiError(
        response.status ? 'http' : 'network',
        response.error || response.text || `HTTP ${response.status}`,
        response.status || undefined
      )
    }
    return parseAsrResponseText(response.text, response.contentType)
  }

  if (!options.audio) {
    throw new Error('Missing audio payload')
  }

  const form = new FormData()
  form.append('file', options.audio, 'recording.wav')
  form.append('model', model)
  if (options.language !== 'auto') {
    form.append('language', options.language)
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  const raw = await response.text()
  if (!response.ok) {
    throw new ApiError('http', raw || response.statusText, response.status)
  }
  return parseAsrResponseText(raw, response.headers.get('Content-Type') ?? '')
}

export const transcribeConfiguredAudio = async (
  audio: Blob | undefined,
  signal?: AbortSignal
): Promise<string> => {
  const voiceState = useVoiceConfig.getState()
  const provider = voiceState.config.asrProvider
  if (provider === 'deepseek') {
    const apiKey = useSettings.getState().apiKey?.trim()
    if (!apiKey) {
      throw new VoiceConfigError('missingDeepSeekKey', '请先填写 DeepSeek API Key')
    }
    if (!audio) {
      return ''
    }
    return transcribeWithDeepSeek(apiKey, audio, signal)
  }
  if (provider === 'openai') {
    return transcribeWithOpenAi({
      baseUrl: voiceState.config.openaiAsr.baseUrl,
      apiKey: voiceState.secrets.asrApiKey,
      model: voiceState.config.openaiAsr.model,
      language: voiceState.config.openaiAsr.language,
      audio,
      signal,
    })
  }
  return ''
}

export type SystemAsrCallbacks = {
  onReady: () => void
  onPartial?: (text: string) => void
  onResult: (text: string) => void
  onError: (kind: 'empty' | 'denied' | 'network' | 'unavailable' | 'error') => void
}

export type SystemAsrSession = {
  stop: () => void
  cancel: () => void
  level: () => number
}

export const startSystemSpeechRecognition = (
  language: AsrLanguage,
  callbacks: SystemAsrCallbacks
): SystemAsrSession => {
  const langTag = asrLanguageToBcp47(language)
  if (android?.startSystemAsr) {
    let closed = false
    const cleanup = () => {
      if (closed) {
        return
      }
      closed = true
      window.removeEventListener('android-system-asr', onEvent)
    }
    const onEvent = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          type?: string
          text?: string
          kind?: 'empty' | 'denied' | 'network' | 'unavailable' | 'error'
        }>
      ).detail
      if (!detail || closed) {
        return
      }
      switch (detail.type) {
        case 'ready':
          callbacks.onReady()
          break
        case 'partial':
          if (typeof detail.text === 'string' && detail.text.trim()) {
            callbacks.onPartial?.(detail.text)
          }
          break
        case 'result':
          cleanup()
          callbacks.onResult(typeof detail.text === 'string' ? detail.text : '')
          break
        case 'error':
          cleanup()
          callbacks.onError(detail.kind ?? 'error')
          break
      }
    }
    window.addEventListener('android-system-asr', onEvent)
    android.startSystemAsr(langTag)
    return {
      stop: () => {
        if (!closed) {
          android?.stopSystemAsr?.()
        }
      },
      cancel: () => {
        cleanup()
        android?.cancelSystemAsr?.()
      },
      level: () => android?.systemAsrLevel?.() ?? 0,
    }
  }

  type WebSpeechRecognition = {
    lang: string
    interimResults: boolean
    continuous: boolean
    onstart: (() => void) | null
    onresult:
      | ((event: {
          results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal?: boolean }>
        }) => void)
      | null
    onerror: ((event: { error?: string }) => void) | null
    onend: (() => void) | null
    start: () => void
    stop: () => void
    abort: () => void
  }

  const win = window as unknown as {
    SpeechRecognition?: new () => WebSpeechRecognition
    webkitSpeechRecognition?: new () => WebSpeechRecognition
  }
  const Ctor = win.SpeechRecognition || win.webkitSpeechRecognition
  if (!Ctor) {
    queueMicrotask(() => callbacks.onError('unavailable'))
    return { stop: () => {}, cancel: () => {}, level: () => 0 }
  }

  const recognition = new Ctor()
  recognition.lang = langTag || (typeof navigator !== 'undefined' ? navigator.language : 'zh-CN')
  recognition.interimResults = true
  recognition.continuous = false

  let latestText = ''
  let settled = false

  recognition.onstart = () => {
    if (!settled) {
      callbacks.onReady()
    }
  }
  recognition.onresult = (event) => {
    if (settled) {
      return
    }
    let combined = ''
    for (let i = 0; i < event.results.length; i += 1) {
      combined += event.results[i]?.[0]?.transcript ?? ''
    }
    latestText = combined.trim()
    if (latestText) {
      callbacks.onPartial?.(latestText)
    }
  }
  recognition.onerror = (event) => {
    if (settled) {
      return
    }
    settled = true
    const err = event.error ?? ''
    if (err === 'no-speech') {
      callbacks.onError('empty')
    } else if (err === 'not-allowed' || err === 'service-not-allowed') {
      callbacks.onError('denied')
    } else if (err === 'network') {
      callbacks.onError('network')
    } else {
      callbacks.onError('error')
    }
  }
  recognition.onend = () => {
    if (settled) {
      return
    }
    settled = true
    if (latestText) {
      callbacks.onResult(latestText)
    } else {
      callbacks.onError('empty')
    }
  }

  try {
    recognition.start()
  } catch {
    settled = true
    queueMicrotask(() => callbacks.onError('error'))
  }

  return {
    stop: () => {
      if (!settled) {
        try {
          recognition.stop()
        } catch {
          // Ignore stop errors if recognition already ended.
        }
      }
    },
    cancel: () => {
      settled = true
      try {
        recognition.abort()
      } catch {
        // Ignore abort errors.
      }
    },
    level: () => 0,
  }
}
