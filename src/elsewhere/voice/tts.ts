import { create } from 'zustand'
import { android, speakAndroidSystemTts, synthesizeAndroidEdgeTts } from '../../app/android.js'
import { ApiError } from '../../services/api/client.js'
import { synthesize, TTS_SAMPLE_RATE, type TtsVoice } from '../../services/api/speech.js'
import { useSettings } from '../../services/settings.js'
import { performHttpRequest, performHttpStream } from '../search/http.js'
import {
  buildAudioSpeechUrl,
  buildOpenRouterSpeechModelsUrl,
  clampSpeed,
  useVoiceConfig,
} from './config.js'
import { cleanTextForSpeech, SpeechTextEmptyError, splitSpeechSegments } from './textClean.js'
import type { TtsProviderId, VoiceConfig } from './types.js'

export class VoiceConfigError extends Error {
  constructor(
    readonly code: 'missingDeepSeekKey' | 'missingOpenAiConfig' | 'unavailable',
    message: string
  ) {
    super(message)
    this.name = 'VoiceConfigError'
  }
}

export const speedToEdgeRate = (speed: number): string => {
  const clamped = clampSpeed(speed, 0.7, 2.0)
  const pct = Math.round((clamped - 1) * 100)
  return `${pct >= 0 ? '+' : ''}${pct}%`
}

export const buildOpenAiTtsRequestBody = (options: {
  model: string
  input: string
  voice: string
  speed: number
  responseFormat?: 'mp3' | 'pcm'
}): Record<string, unknown> => {
  const clampedSpeed = clampSpeed(options.speed, 0.5, 2.0)
  return {
    model: options.model.trim(),
    input: options.input,
    voice: options.voice.trim(),
    response_format: options.responseFormat ?? 'mp3',
    ...(Math.abs(clampedSpeed - 1.0) > 0.001 ? { speed: clampedSpeed } : {}),
  }
}

export const shouldRetryOpenAiTtsAsPcm = (status: number, bodyText: string): boolean => {
  if (status !== 400) {
    return false
  }
  const lower = bodyText.toLowerCase()
  return (
    /response_format|unsupported.*format|invalid.*format|only.*pcm/.test(lower) ||
    (lower.includes('mp3') &&
      (lower.includes('pcm') || lower.includes('format') || lower.includes('unsupported')))
  )
}

export const parseOpenRouterSpeechVoices = (rawJson: string, modelId?: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(rawJson)
    if (!parsed || typeof parsed !== 'object') {
      return []
    }
    const data = (parsed as { data?: unknown }).data
    if (!Array.isArray(data)) {
      return []
    }

    const extractVoicesFromOutputModalities = (modalities: unknown): string[] => {
      if (!Array.isArray(modalities)) {
        return []
      }
      const out: string[] = []
      for (const mod of modalities) {
        if (!mod || typeof mod !== 'object') {
          continue
        }
        const obj = mod as Record<string, unknown>
        if (obj.type !== 'speech') {
          continue
        }
        const supported = obj.supported_parameters
        if (!supported || typeof supported !== 'object') {
          continue
        }
        const voice = (supported as Record<string, unknown>).voice
        if (!voice || typeof voice !== 'object') {
          continue
        }
        const values = (voice as Record<string, unknown>).values
        if (!Array.isArray(values)) {
          continue
        }
        for (const v of values) {
          if (typeof v === 'string' && v.trim()) {
            out.push(v.trim())
          }
        }
      }
      return out
    }

    const extractVoicesFromModel = (entry: Record<string, unknown>): string[] => {
      const top = extractVoicesFromOutputModalities(entry.output_modalities)
      if (top.length > 0) {
        return top
      }
      if (Array.isArray(entry.endpoints)) {
        for (const ep of entry.endpoints) {
          if (!ep || typeof ep !== 'object') {
            continue
          }
          const epVoices = extractVoicesFromOutputModalities(
            (ep as Record<string, unknown>).output_modalities
          )
          if (epVoices.length > 0) {
            return epVoices
          }
        }
      }
      return []
    }

    const trimmedTarget = modelId?.trim().toLowerCase()
    if (trimmedTarget) {
      const exact = data.find(
        (item) =>
          item &&
          typeof item === 'object' &&
          typeof (item as Record<string, unknown>).id === 'string' &&
          ((item as Record<string, unknown>).id as string).toLowerCase() === trimmedTarget
      ) as Record<string, unknown> | undefined
      if (exact) {
        const voices = extractVoicesFromModel(exact)
        if (voices.length > 0) {
          return Array.from(new Set(voices))
        }
      }
    }

    const fallbackVoices: string[] = []
    for (const item of data) {
      if (!item || typeof item !== 'object') {
        continue
      }
      for (const v of extractVoicesFromModel(item as Record<string, unknown>)) {
        fallbackVoices.push(v)
        if (fallbackVoices.length >= 200) {
          return Array.from(new Set(fallbackVoices))
        }
      }
    }
    return Array.from(new Set(fallbackVoices))
  } catch {
    return []
  }
}

export const fetchOpenRouterSpeechVoices = async (
  baseUrl: string,
  apiKey: string,
  modelId?: string,
  signal?: AbortSignal
): Promise<string[]> => {
  const url = buildOpenRouterSpeechModelsUrl(baseUrl)
  if (!url) {
    throw new VoiceConfigError('missingOpenAiConfig', '接口地址无效')
  }
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`
  }
  const response = await performHttpRequest(
    {
      url,
      method: 'GET',
      headers,
      timeoutMs: 15_000,
    },
    signal
  )
  if (!response.ok) {
    throw new ApiError(
      response.status ? 'http' : 'network',
      response.error || response.text || `HTTP ${response.status}`,
      response.status || undefined
    )
  }
  return parseOpenRouterSpeechVoices(response.text, modelId)
}

/** 16-bit 小端 PCM 转 Float32 */
export const toFloat32Pcm = (bytes: Uint8Array): Float32Array<ArrayBuffer> => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

export const createSpeechAudioContext = (sampleRate = TTS_SAMPLE_RATE): AudioContext => {
  const AudioCtx =
    typeof AudioContext !== 'undefined'
      ? AudioContext
      : (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) {
    throw new Error('AudioContext is not supported')
  }
  try {
    return new AudioCtx({ sampleRate })
  } catch {
    return new AudioCtx()
  }
}

const decodeEncodedAudio = (context: AudioContext, bytes: Uint8Array): Promise<AudioBuffer> => {
  const copied = bytes.slice().buffer
  return new Promise<AudioBuffer>((resolve, reject) => {
    try {
      const maybePromise = context.decodeAudioData(copied, resolve, reject)
      if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === 'function') {
        void (maybePromise as Promise<AudioBuffer>).then(resolve, reject)
      }
    } catch (error) {
      reject(error)
    }
  })
}

const readAllStreamBytes = async (
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): Promise<Uint8Array> => {
  const reader = stream.getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      if (value && value.length > 0) {
        chunks.push(value)
        total += value.length
      }
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

const parseApiErrorMessage = (status: number, bodyText: string): ApiError => {
  let message = bodyText || `HTTP ${status}`
  let code: string | undefined
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'error' in parsed &&
      (parsed as { error?: { message?: unknown } }).error?.message
    ) {
      const errObj = (parsed as { error: { message: unknown; code?: unknown } }).error
      if (typeof errObj.message === 'string') {
        message = errObj.message
      }
      if (typeof errObj.code === 'string') {
        code = errObj.code
      }
    }
  } catch {
    // Keep raw text when body is not JSON.
  }
  return new ApiError('http', message, status, code)
}

const waitUntilCloseTo = (
  context: AudioContext,
  targetTime: number,
  leadSeconds: number,
  signal: AbortSignal
): Promise<void> => {
  const waitMs = Math.max(0, (targetTime - context.currentTime - leadSeconds) * 1000)
  if (waitMs <= 15 || signal.aborted) {
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, waitMs)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export type SpeakPlaybackOptions = {
  text: string
  signal: AbortSignal
  context: AudioContext | null
  onPlaying: () => void
  overrideConfig?: {
    provider?: TtsProviderId
    edgeVoiceId?: string
    edgeSpeed?: number
    deepSeekVoice?: TtsVoice
    systemVoiceId?: string
    systemSpeed?: number
  }
}

const playDeepSeekTts = async (
  apiKey: string,
  text: string,
  voice: TtsVoice,
  context: AudioContext,
  signal: AbortSignal,
  onPlaying: () => void
): Promise<void> => {
  const stream = await synthesize(apiKey, text, voice, signal)
  const reader = stream.getReader()
  const onAbort = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', onAbort, { once: true })

  let nextTime = 0
  let lastSource: AudioBufferSourceNode | null = null
  let rest = new Uint8Array(0)
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || signal.aborted) {
        break
      }
      const bytes = new Uint8Array(rest.length + value.length)
      bytes.set(rest)
      bytes.set(value, rest.length)
      const samples = toFloat32Pcm(bytes)
      rest = bytes.slice(samples.length * 2)
      if (samples.length === 0) {
        continue
      }

      const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : 0.1))
      source.start(nextTime)
      nextTime += buffer.duration
      lastSource = source
      onPlaying()
    }
    if (lastSource && !signal.aborted) {
      const endSource = lastSource
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener('abort', finish)
          resolve()
        }
        signal.addEventListener('abort', finish, { once: true })
        endSource.onended = finish
      })
    }
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

type SynthesizedChunk = { kind: 'encoded'; bytes: Uint8Array } | { kind: 'pcm'; bytes: Uint8Array }

export const playSegmentedAudioPipeline = async (options: {
  segments: string[]
  context: AudioContext
  signal: AbortSignal
  onPlaying: () => void
  fetchSegment: (segment: string, signal: AbortSignal) => Promise<SynthesizedChunk>
}): Promise<void> => {
  const { segments, context, signal, onPlaying, fetchSegment } = options
  if (segments.length === 0 || signal.aborted) {
    return
  }

  const pipelineController = new AbortController()
  const onParentAbort = () => {
    pipelineController.abort(signal.reason)
  }
  signal.addEventListener('abort', onParentAbort, { once: true })

  let nextTime = 0
  let lastSource: AudioBufferSourceNode | null = null
  let currentPromise: Promise<SynthesizedChunk> = fetchSegment(
    segments[0],
    pipelineController.signal
  )
  let unawaitedFetch: Promise<SynthesizedChunk> | null = currentPromise

  try {
    for (let i = 0; i < segments.length; i += 1) {
      if (pipelineController.signal.aborted) {
        return
      }
      const nextFetch =
        i + 1 < segments.length ? fetchSegment(segments[i + 1], pipelineController.signal) : null
      unawaitedFetch = nextFetch ?? unawaitedFetch

      let chunk: SynthesizedChunk
      try {
        chunk = await currentPromise
      } catch (error) {
        unawaitedFetch = nextFetch
        throw error
      }
      if (!nextFetch) {
        unawaitedFetch = null
      }
      if (pipelineController.signal.aborted) {
        return
      }

      let audioBuffer: AudioBuffer
      if (chunk.kind === 'pcm') {
        const samples = toFloat32Pcm(chunk.bytes)
        if (samples.length === 0) {
          if (nextFetch) {
            currentPromise = nextFetch
            unawaitedFetch = nextFetch
            continue
          }
          break
        }
        audioBuffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
        audioBuffer.copyToChannel(samples, 0)
      } else {
        audioBuffer = await decodeEncodedAudio(context, chunk.bytes)
      }
      if (pipelineController.signal.aborted) {
        return
      }

      const source = context.createBufferSource()
      source.buffer = audioBuffer
      source.connect(context.destination)
      nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : 0.08))
      source.start(nextTime)
      nextTime += audioBuffer.duration
      lastSource = source
      onPlaying()

      if (nextFetch) {
        currentPromise = nextFetch
        unawaitedFetch = nextFetch
        await waitUntilCloseTo(context, nextTime, 0.35, pipelineController.signal)
      }
    }

    if (lastSource && !pipelineController.signal.aborted) {
      const endSource = lastSource
      await new Promise<void>((resolve) => {
        const finish = () => {
          pipelineController.signal.removeEventListener('abort', finish)
          resolve()
        }
        pipelineController.signal.addEventListener('abort', finish, { once: true })
        endSource.onended = finish
      })
    }
  } finally {
    signal.removeEventListener('abort', onParentAbort)
    pipelineController.abort()
    if (unawaitedFetch) {
      void unawaitedFetch.catch(() => {})
    }
  }
}

const playOpenAiTts = async (options: {
  config: VoiceConfig['openaiTts']
  apiKey: string
  segments: string[]
  context: AudioContext
  signal: AbortSignal
  onPlaying: () => void
}): Promise<void> => {
  const { config, apiKey, segments, context, signal, onPlaying } = options
  const url = buildAudioSpeechUrl(config.baseUrl)
  if (!url || !config.model.trim() || !config.voice.trim() || !apiKey.trim()) {
    throw new VoiceConfigError('missingOpenAiConfig', '请先完善语音朗读接口配置')
  }

  let activeFormat: 'mp3' | 'pcm' = 'mp3'

  const requestOnce = async (
    segment: string,
    format: 'mp3' | 'pcm',
    segSignal: AbortSignal
  ): Promise<
    { ok: true; chunk: SynthesizedChunk } | { ok: false; status: number; errText: string }
  > => {
    const body = JSON.stringify(
      buildOpenAiTtsRequestBody({
        model: config.model,
        input: segment,
        voice: config.voice,
        speed: config.speed,
        responseFormat: format,
      })
    )
    const handle = performHttpStream(
      {
        url,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body,
        timeoutMs: 45_000,
      },
      segSignal
    )
    const onAbort = () => handle.close()
    segSignal.addEventListener('abort', onAbort, { once: true })
    try {
      const res = await handle.response
      const bytes = res.body ? await readAllStreamBytes(res.body, segSignal) : new Uint8Array(0)
      if (!res.ok) {
        const errText = new TextDecoder().decode(bytes)
        return { ok: false, status: res.status, errText }
      }
      const ct = res.contentType.toLowerCase()
      const isPcm = format === 'pcm' || ct.includes('audio/pcm') || ct.includes('audio/l16')
      return {
        ok: true,
        chunk: isPcm ? { kind: 'pcm', bytes } : { kind: 'encoded', bytes },
      }
    } finally {
      segSignal.removeEventListener('abort', onAbort)
    }
  }

  await playSegmentedAudioPipeline({
    segments,
    context,
    signal,
    onPlaying,
    fetchSegment: async (segment, segSignal) => {
      const first = await requestOnce(segment, activeFormat, segSignal)
      if (first.ok) {
        return first.chunk
      }
      if (activeFormat === 'mp3' && shouldRetryOpenAiTtsAsPcm(first.status, first.errText)) {
        activeFormat = 'pcm'
        const second = await requestOnce(segment, 'pcm', segSignal)
        if (second.ok) {
          return second.chunk
        }
        throw parseApiErrorMessage(second.status, second.errText)
      }
      throw parseApiErrorMessage(first.status, first.errText)
    },
  })
}

const playWebSystemSpeechSegment = (
  text: string,
  voiceId: string,
  rate: number,
  signal: AbortSignal,
  onStart: () => void
): Promise<void> => {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    return Promise.reject(new VoiceConfigError('unavailable', '当前环境不支持系统语音'))
  }
  const synth = window.speechSynthesis
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = clampSpeed(rate, 0.7, 2.0)
    if (voiceId) {
      const voices = synth.getVoices()
      const matched = voices.find((v) => v.voiceURI === voiceId || v.name === voiceId)
      if (matched) {
        utterance.voice = matched
      }
    }
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      cleanup()
      synth.cancel()
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    utterance.onstart = () => onStart()
    utterance.onend = () => {
      cleanup()
      resolve()
    }
    utterance.onerror = () => {
      cleanup()
      reject(new Error('System speech playback failed'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    synth.cancel()
    synth.speak(utterance)
  })
}

const playSystemTts = async (options: {
  segments: string[]
  voiceId: string
  speed: number
  signal: AbortSignal
  onPlaying: () => void
}): Promise<void> => {
  const { segments, voiceId, speed, signal, onPlaying } = options
  for (const segment of segments) {
    if (signal.aborted) {
      return
    }
    if (android?.speakSystemTts) {
      await speakAndroidSystemTts({ text: segment, voiceId, rate: speed }, signal, onPlaying)
    } else {
      await playWebSystemSpeechSegment(segment, voiceId, speed, signal, onPlaying)
    }
  }
}

export const stopActiveSystemTts = () => {
  if (android?.stopSystemTts) {
    android.stopSystemTts()
  } else if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    window.speechSynthesis.cancel()
  }
}

export const playSpeech = async (options: SpeakPlaybackOptions): Promise<void> => {
  const { text, signal, context, onPlaying, overrideConfig } = options
  const voiceState = useVoiceConfig.getState()
  const settingsState = useSettings.getState()
  const config = voiceState.config
  const provider = overrideConfig?.provider ?? config.ttsProvider

  if (provider === 'deepseek') {
    const apiKey = settingsState.apiKey?.trim()
    if (!apiKey) {
      throw new VoiceConfigError('missingDeepSeekKey', '请先填写 DeepSeek API Key')
    }
    if (!context) {
      throw new Error('AudioContext is required')
    }
    const voice = overrideConfig?.deepSeekVoice ?? settingsState.ttsVoice
    await playDeepSeekTts(apiKey, text, voice, context, signal, onPlaying)
    return
  }

  const cleaned = cleanTextForSpeech(text)
  if (!cleaned) {
    throw new SpeechTextEmptyError()
  }
  const segments = splitSpeechSegments(
    cleaned,
    provider === 'system' ? { firstMax: 400, targetMax: 400, hardMax: 400 } : undefined
  )
  if (segments.length === 0) {
    throw new SpeechTextEmptyError()
  }

  if (provider === 'edge') {
    if (!android?.beginEdgeTts) {
      throw new VoiceConfigError('unavailable', '当前环境不支持 Edge 语音')
    }
    if (!context) {
      throw new Error('AudioContext is required')
    }
    const edgeVoiceId = overrideConfig?.edgeVoiceId ?? config.edgeVoiceId
    const edgeSpeed = overrideConfig?.edgeSpeed ?? config.edgeSpeed
    const rate = speedToEdgeRate(edgeSpeed)
    await playSegmentedAudioPipeline({
      segments,
      context,
      signal,
      onPlaying,
      fetchSegment: async (segment, segSignal) => ({
        kind: 'encoded',
        bytes: await synthesizeAndroidEdgeTts(
          { text: segment, voice: edgeVoiceId, rate },
          segSignal
        ),
      }),
    })
    return
  }

  if (provider === 'openai') {
    if (!context) {
      throw new Error('AudioContext is required')
    }
    await playOpenAiTts({
      config: config.openaiTts,
      apiKey: voiceState.secrets.ttsApiKey,
      segments,
      context,
      signal,
      onPlaying,
    })
    return
  }

  const systemVoiceId = overrideConfig?.systemVoiceId ?? config.systemTts.voiceId
  const systemSpeed = overrideConfig?.systemSpeed ?? config.systemTts.speed
  await playSystemTts({
    segments,
    voiceId: systemVoiceId,
    speed: systemSpeed,
    signal,
    onPlaying,
  })
}

export const getSamplePreviewText = (langHint?: string): string => {
  const lower = (langHint ?? '').toLowerCase()
  if (lower.startsWith('en')) {
    return 'Hello, this is a voice preview for Elsewhere.'
  }
  if (lower.startsWith('ja')) {
    return 'こんにちは、こちらは音声のプレビューです。'
  }
  return '你好，这是 Elsewhere 的语音朗读试听效果。'
}

export const useVoicePreview = create<{ playingId: string | null }>(() => ({ playingId: null }))

let activePreview: {
  id: string
  controller: AbortController
  context: AudioContext | null
} | null = null
const externalStopHooks = new Set<() => void>()

export const registerReadAloudStopHook = (fn: () => void): (() => void) => {
  externalStopHooks.add(fn)
  return () => externalStopHooks.delete(fn)
}

export const stopVoicePreview = () => {
  if (!activePreview) {
    return
  }
  const { controller, context } = activePreview
  activePreview = null
  controller.abort()
  stopActiveSystemTts()
  if (context) {
    void context.close().catch(() => {})
  }
  useVoicePreview.setState({ playingId: null })
}

export const toggleVoicePreview = (
  previewId: string,
  options: {
    text: string
    overrideConfig?: SpeakPlaybackOptions['overrideConfig']
  },
  onError: (error: unknown) => void
) => {
  const currentId = useVoicePreview.getState().playingId
  stopVoicePreview()
  for (const stopExternal of externalStopHooks) {
    stopExternal()
  }
  if (currentId === previewId) {
    return
  }
  const controller = new AbortController()
  const provider = options.overrideConfig?.provider ?? useVoiceConfig.getState().config.ttsProvider
  const context = provider === 'system' ? null : createSpeechAudioContext(TTS_SAMPLE_RATE)
  if (context && context.state === 'suspended') {
    void context.resume().catch(() => {})
  }
  activePreview = { id: previewId, controller, context }
  useVoicePreview.setState({ playingId: previewId })

  void (async () => {
    try {
      await playSpeech({
        text: options.text,
        signal: controller.signal,
        context,
        overrideConfig: options.overrideConfig,
        onPlaying: () => {},
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort()
        onError(error)
      }
    } finally {
      if (activePreview?.controller === controller) {
        if (context) {
          void context.close().catch(() => {})
        }
        activePreview = null
        useVoicePreview.setState({ playingId: null })
      }
    }
  })()
}
