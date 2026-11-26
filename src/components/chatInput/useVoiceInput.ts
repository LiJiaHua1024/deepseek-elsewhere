import { useCallback, useEffect, useRef, useState } from 'react'
import type { TranslationMessage } from '../../i18n/index.js'
import { startRecording, type Recording } from '../../services/speech/recorder.js'
import { android } from '../../app/android.js'
import { useVoiceConfig } from '../../elsewhere/voice/config.js'
import {
  startSystemSpeechRecognition,
  transcribeConfiguredAudio,
  type SystemAsrSession,
} from '../../elsewhere/voice/asr.js'
import { VoiceConfigError } from '../../elsewhere/voice/tts.js'
import { showToast } from '../base/toastState.js'

export type VoiceInputStatus = 'idle' | 'recording' | 'transcribing'

/**
 * 录音依赖 getUserMedia，只在安全上下文可用（HTTPS、localhost、file://）。
 * 普通 HTTP 页面上直接禁用入口，避免点击后必然失败。
 */
const AVAILABLE = typeof window === 'undefined' || window.isSecureContext

const describeRecordingError = (error: unknown): TranslationMessage | string => {
  if (error instanceof VoiceConfigError) {
    return error.message
  }
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return { key: android ? 'androidMicPermissionDenied' : 'voiceInputPermissionDenied' }
    }
    if (error.name === 'NotFoundError') {
      return { key: 'voiceInputNoDevice' }
    }
  }
  return { key: 'voiceInputFailed' }
}

/**
 * 语音输入（oneshot）：支持 DeepSeek 官方、OpenAI 兼容接口（原生/FormData 上传）与系统识别。
 * 点击或按住开始，结束或松手后返回文本交给 onText；转写中再次点击取消。录满 120 秒自动结束。
 */
export const useVoiceInput = (onText: (text: string) => void) => {
  const [status, setStatus] = useState<VoiceInputStatus>('idle')
  /** 本次录音已录秒数，只在录音中递增 */
  const [seconds, setSeconds] = useState(0)
  const recordingRef = useRef<Recording | null>(null)
  const systemAsrRef = useRef<SystemAsrSession | null>(null)
  const systemPartialRef = useRef('')
  const systemPendingFinishRef = useRef<((text: string | null) => void) | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const operationRef = useRef(0)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  const cancelOperation = useCallback(() => {
    operationRef.current++
    recordingRef.current?.cancel()
    recordingRef.current = null
    systemAsrRef.current?.cancel()
    systemAsrRef.current = null
    systemPartialRef.current = ''
    const pending = systemPendingFinishRef.current
    systemPendingFinishRef.current = null
    pending?.(null)
    controllerRef.current?.abort()
    controllerRef.current = null
  }, [])

  const cancel = useCallback(() => {
    cancelOperation()
    setStatus('idle')
  }, [cancelOperation])

  const deliverText = useCallback((rawText: string) => {
    const trimmed = rawText.trim()
    if (trimmed) {
      onTextRef.current(trimmed)
    } else {
      showToast({ key: android ? 'androidVoiceInputEmpty' : 'voiceInputEmpty' })
    }
  }, [])

  const finish = useCallback(async () => {
    const systemAsr = systemAsrRef.current
    if (systemAsr) {
      const operation = operationRef.current
      setStatus('transcribing')
      const waitResult = new Promise<string | null>((resolve) => {
        const timeout = setTimeout(() => {
          if (systemPendingFinishRef.current) {
            systemPendingFinishRef.current = null
            resolve(systemPartialRef.current)
          }
        }, 6000)
        systemPendingFinishRef.current = (text) => {
          clearTimeout(timeout)
          systemPendingFinishRef.current = null
          resolve(text)
        }
      })
      systemAsr.stop()
      const settledText = await waitResult
      if (operationRef.current !== operation) {
        return
      }
      systemAsrRef.current = null
      systemPartialRef.current = ''
      setStatus('idle')
      if (settledText !== null) {
        deliverText(settledText)
      }
      return
    }

    const recording = recordingRef.current
    if (!recording) {
      // 仍在等待麦克风授权时也允许取消；迟到的录音对象会立即释放。
      cancel()
      return
    }
    const operation = operationRef.current
    recordingRef.current = null
    let controller: AbortController | null = null
    try {
      let audio: Blob | null
      try {
        audio = await recording.stop()
      } finally {
        recording.cancel()
      }
      if (operationRef.current !== operation || !audio) {
        return
      }
      const provider = useVoiceConfig.getState().config.asrProvider
      const useNativeWav = Boolean(android?.beginAsrUpload && provider === 'openai')
      controller = new AbortController()
      controllerRef.current = controller
      setStatus('transcribing')
      const text = await transcribeConfiguredAudio(
        useNativeWav ? undefined : audio,
        controller.signal
      )
      if (controller.signal.aborted || operationRef.current !== operation) {
        return
      }
      deliverText(text)
    } catch (error) {
      if (operationRef.current === operation && !controller?.signal.aborted) {
        showToast(describeRecordingError(error))
      }
    } finally {
      if (operationRef.current === operation) {
        controllerRef.current = null
        setStatus('idle')
      }
    }
  }, [cancel, deliverText])

  const start = useCallback(async () => {
    if (!AVAILABLE) {
      return
    }
    if (status !== 'idle') {
      return
    }
    const operation = ++operationRef.current
    const voiceConfig = useVoiceConfig.getState().config

    if (voiceConfig.asrProvider === 'system') {
      setStatus('recording')
      systemPartialRef.current = ''
      systemPendingFinishRef.current = null
      const session = startSystemSpeechRecognition(voiceConfig.systemAsrLanguage, {
        onReady: () => {},
        onPartial: (text) => {
          if (operationRef.current === operation) {
            systemPartialRef.current = text
          }
        },
        onResult: (text) => {
          if (operationRef.current !== operation) {
            return
          }
          const finalText = text.trim() || systemPartialRef.current.trim()
          if (systemPendingFinishRef.current) {
            systemPendingFinishRef.current(finalText)
          } else {
            systemAsrRef.current = null
            systemPartialRef.current = ''
            setStatus('idle')
            deliverText(finalText)
          }
        },
        onError: (kind) => {
          if (operationRef.current !== operation) {
            return
          }
          const pending = systemPendingFinishRef.current
          if (pending) {
            if (kind === 'empty' && systemPartialRef.current.trim()) {
              pending(systemPartialRef.current.trim())
              return
            }
            pending(null)
          } else {
            systemAsrRef.current = null
            systemPartialRef.current = ''
            setStatus('idle')
          }
          showToast(
            kind === 'denied'
              ? { key: android ? 'androidMicPermissionDenied' : 'voiceInputPermissionDenied' }
              : kind === 'empty'
                ? { key: android ? 'androidVoiceInputEmpty' : 'voiceInputEmpty' }
                : { key: 'voiceInputFailed' }
          )
        },
      })
      if (operationRef.current !== operation) {
        session.cancel()
        return
      }
      systemAsrRef.current = session
      return
    }

    setStatus('recording')
    try {
      const keepNativeWav = Boolean(android?.beginAsrUpload && voiceConfig.asrProvider === 'openai')
      const recording = await startRecording(
        () => {
          if (operationRef.current === operation) {
            showToast({ key: 'voiceInputLimitReached' })
            void finish()
          }
        },
        { keepNativeWav }
      )
      if (operationRef.current !== operation) {
        recording.cancel()
        return
      }
      recordingRef.current = recording
    } catch (error) {
      if (operationRef.current === operation) {
        setStatus('idle')
        showToast(describeRecordingError(error))
      }
    }
  }, [status, finish, deliverText])

  const toggle = async () => {
    if (status === 'recording') {
      await finish()
    } else if (status === 'transcribing') {
      cancel()
    } else {
      await start()
    }
  }

  useEffect(() => {
    if (status !== 'recording') {
      return
    }
    const startedAt = Date.now()
    setSeconds(0)
    // 半秒刷新一次，让显示的秒数与实际录音时长保持一致
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [status])

  useEffect(() => cancelOperation, [cancelOperation])
  useEffect(() => {
    if (!android) {
      return
    }
    window.addEventListener('android-recording-interrupted', cancel)
    return () => window.removeEventListener('android-recording-interrupted', cancel)
  }, [cancel])

  /** 当前录音的频谱分析节点，未录音时为 null */
  const getAnalyser = useCallback(() => recordingRef.current?.analyser ?? null, [])
  const getLevel = useCallback(() => {
    if (systemAsrRef.current) {
      return systemAsrRef.current.level()
    }
    return recordingRef.current?.level?.() ?? 0
  }, [])

  return {
    status,
    seconds,
    getAnalyser,
    getLevel,
    start,
    finish,
    toggle,
    cancel,
    available: AVAILABLE,
  }
}
