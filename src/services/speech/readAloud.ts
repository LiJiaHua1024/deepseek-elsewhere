import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { ApiError } from '../api/client.js'
import { classifyApiError } from '../api/errors.js'
import { TTS_SAMPLE_RATE } from '../api/speech.js'
import { android } from '../../app/android.js'
import { showToast } from '../../components/base/toastState.js'
import { useVoiceConfig } from '../../elsewhere/voice/config.js'
import { SpeechTextEmptyError } from '../../elsewhere/voice/textClean.js'
import {
  createSpeechAudioContext,
  playSpeech,
  registerReadAloudStopHook,
  stopActiveSystemTts,
  stopVoicePreview,
  VoiceConfigError,
} from '../../elsewhere/voice/tts.js'

/**
 * 朗读：同一时间只读一条回复。
 * 统一调度 DeepSeek 官方流式 PCM、Edge 语音、OpenAI 兼容接口与系统语音。
 * 状态：loading（已请求、未出声）→ playing → 结束回到 idle。
 */
export type ReadAloudStatus = 'idle' | 'loading' | 'playing'

type ReadAloudState = {
  /** 正在朗读的回复 id */
  messageId: string | null
  status: ReadAloudStatus
}

export const useReadAloud = create<ReadAloudState>(() => ({ messageId: null, status: 'idle' }))

let current: { controller: AbortController; context: AudioContext | null } | null = null

const finish = (controller: AbortController) => {
  if (current?.controller !== controller) {
    return
  }
  if (current.context) {
    void current.context.close().catch(() => {})
  }
  current = null
  useReadAloud.setState({ messageId: null, status: 'idle' })
}

/** 停止当前朗读（发送、停止生成、切换会话等场景调用） */
export const stopReadAloud = () => {
  if (current) {
    const { controller } = current
    controller.abort()
    stopActiveSystemTts()
    finish(controller)
  }
}

registerReadAloudStopHook(stopReadAloud)

export const describeReadAloudError = (error: unknown): TranslationMessage | string => {
  if (error instanceof SpeechTextEmptyError) {
    return { key: 'ttsUnavailable' }
  }
  if (error instanceof VoiceConfigError) {
    return error.message
  }
  if (error instanceof ApiError && error.kind === 'protocol') {
    return error.message
  }
  // 400 表示这段正文服务端无法合成，与其余失败区分开
  if (error instanceof ApiError && error.status === 400) {
    return { key: 'ttsUnavailable' }
  }
  switch (classifyApiError(error)) {
    case 'unauthorized':
      return { key: 'apiKeyInvalidRetry' }
    case 'insufficientBalance':
      return { key: 'insufficientBalance' }
    case 'rateLimited':
      return { key: 'rateLimited' }
    default:
      return { key: 'ttsFailed' }
  }
}

/**
 * 开始朗读一条回复的正文；同一条正在朗读时调用等于停止。
 * 必须在点击事件中同步调用：AudioContext 需要用户手势才能出声。
 */
export const toggleReadAloud = (
  messageId: string,
  text: string,
  onError: (error: unknown) => void
) => {
  const reading = useReadAloud.getState().messageId
  stopVoicePreview()
  stopReadAloud()
  if (reading === messageId) {
    return
  }
  const controller = new AbortController()
  const provider = useVoiceConfig.getState().config.ttsProvider
  const context = provider === 'system' ? null : createSpeechAudioContext(TTS_SAMPLE_RATE)
  if (context && context.state === 'suspended') {
    void context.resume().catch(() => {})
  }
  current = { controller, context }
  useReadAloud.setState({ messageId, status: 'loading' })

  void (async () => {
    try {
      await playSpeech({
        text,
        signal: controller.signal,
        context,
        onPlaying: () => {
          if (current?.controller === controller && useReadAloud.getState().status === 'loading') {
            useReadAloud.setState({ status: 'playing' })
            if (android?.getMusicVolume?.() === 0) {
              showToast({ key: 'readAloudLowVolume' }, 1900)
            }
          }
        },
      })
      finish(controller)
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort()
        finish(controller)
        onError(error)
      }
    }
  })()
}
