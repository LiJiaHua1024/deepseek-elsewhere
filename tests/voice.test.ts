import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAudioSpeechUrl,
  buildAudioTranscriptionsUrl,
  buildOpenRouterSpeechModelsUrl,
  isAsrReady,
  isOpenRouterUrl,
  isTtsReady,
  resolveDefaultVoiceConfig,
} from '../src/elsewhere/voice/config.js'
import {
  CURATED_EDGE_VOICES,
  filterVoices,
  getEdgeVoiceById,
  localizeEdgeVoices,
  parseEdgeVoicesJson,
} from '../src/elsewhere/voice/edgeVoices.js'
import { cleanTextForSpeech, splitSpeechSegments } from '../src/elsewhere/voice/textClean.js'
import {
  buildOpenAiTtsRequestBody,
  parseOpenRouterSpeechVoices,
  playSegmentedAudioPipeline,
  shouldRetryOpenAiTtsAsPcm,
  speedToEdgeRate,
} from '../src/elsewhere/voice/tts.js'
import { parseAsrResponseText } from '../src/elsewhere/voice/asr.js'

describe('Speech text cleaning and segmentation', () => {
  it('strips fenced code blocks, display math, tables, URLs, citations, and markdown formatting', () => {
    const md = [
      '# 标题一',
      '',
      '> 引用段落，包含 **加粗** 和 [链接文本](https://example.com) 以及[1]。',
      '',
      '```ts',
      'const secret = 123',
      '```',
      '',
      '$$E = mc^2$$',
      '',
      '\\[a^2 + b^2 = c^2\\]',
      '',
      '| 列1 | 列2 |',
      '| --- | --- |',
      '| 值A | 值B |',
      '',
      '更多说明见 https://openai.com/docs。',
    ].join('\n')

    const cleaned = cleanTextForSpeech(md)
    assert.ok(cleaned.includes('标题一'))
    assert.ok(cleaned.includes('引用段落，包含 加粗 和 链接文本 以及。'))
    assert.ok(cleaned.includes('值A，值B'))
    assert.ok(!cleaned.includes('const secret'))
    assert.ok(!cleaned.includes('mc^2'))
    assert.ok(!cleaned.includes('a^2 + b^2'))
    assert.ok(!cleaned.includes('---'))
    assert.ok(!cleaned.includes('https://'))
    assert.ok(!cleaned.includes('[1]'))
  })

  it('returns empty string when input only contains code blocks or math', () => {
    const codeOnly = ['```python', 'print("hello")', '```', '', '$$x = 1$$'].join('\n')
    assert.equal(cleanTextForSpeech(codeOnly), '')
  })

  it('splits long text on sentence boundaries with short first segment and <=400 hard cap', () => {
    const sentence = '这是一段用于测试分段朗读效果的完整中文句子，包含足够多的汉字内容。'
    const longText = Array.from({ length: 24 }, () => sentence).join('')
    const segments = splitSpeechSegments(longText)
    assert.ok(segments.length >= 3)
    assert.ok(segments[0].length <= 120)
    for (const seg of segments) {
      assert.ok(seg.length > 0 && seg.length <= 400)
    }
  })
})

describe('Default voice strategy and readiness checks', () => {
  it('defaults to deepseek when DeepSeek API key is configured', () => {
    const cfg = resolveDefaultVoiceConfig({
      hasDeepSeekKey: true,
      isAndroid: true,
      systemAsrAvailable: true,
    })
    assert.equal(cfg.ttsProvider, 'deepseek')
    assert.equal(cfg.asrProvider, 'deepseek')
  })

  it('defaults to edge/system on Android and system/system on desktop without DeepSeek key', () => {
    const androidCfg = resolveDefaultVoiceConfig({
      hasDeepSeekKey: false,
      isAndroid: true,
      systemAsrAvailable: true,
    })
    assert.equal(androidCfg.ttsProvider, 'edge')
    assert.equal(androidCfg.edgeVoiceId, 'zh-CN-XiaoxiaoNeural')
    assert.equal(androidCfg.edgeSpeed, 1.0)
    assert.equal(androidCfg.asrProvider, 'system')

    const desktopNoSystemAsr = resolveDefaultVoiceConfig({
      hasDeepSeekKey: false,
      isAndroid: false,
      systemAsrAvailable: false,
    })
    assert.equal(desktopNoSystemAsr.ttsProvider, 'system')
    assert.equal(desktopNoSystemAsr.asrProvider, 'openai')
  })

  it('evaluates isTtsReady and isAsrReady without requiring DeepSeek key for external providers', () => {
    const base = resolveDefaultVoiceConfig({
      hasDeepSeekKey: false,
      isAndroid: true,
      systemAsrAvailable: true,
    })

    assert.equal(isTtsReady(base, '', '', { isAndroid: true, systemTtsAvailable: true }), true)
    assert.equal(isTtsReady(base, '', '', { isAndroid: false, systemTtsAvailable: true }), false)
    assert.equal(
      isTtsReady({ ...base, ttsProvider: 'deepseek' }, '', '', { isAndroid: true }),
      false
    )
    assert.equal(
      isTtsReady({ ...base, ttsProvider: 'openai' }, '', 'sk-voice-123', { isAndroid: true }),
      true
    )
    assert.equal(isTtsReady({ ...base, ttsProvider: 'openai' }, '', '', { isAndroid: true }), false)
    assert.equal(
      isTtsReady({ ...base, ttsProvider: 'system' }, '', '', { systemTtsAvailable: true }),
      true
    )

    assert.equal(isAsrReady(base, '', '', { systemAsrAvailable: true }), true)
    assert.equal(isAsrReady(base, '', '', { systemAsrAvailable: false }), false)
    assert.equal(
      isAsrReady({ ...base, asrProvider: 'openai' }, '', 'sk-asr-456', {
        systemAsrAvailable: false,
      }),
      true
    )
  })
})

describe('OpenAI compatible URL normalization, payload, fallback, and OpenRouter voices', () => {
  it('normalizes base URLs with or without /v1 and builds speech/transcription endpoints', () => {
    assert.equal(
      buildAudioSpeechUrl('https://api.siliconflow.cn/v1'),
      'https://api.siliconflow.cn/v1/audio/speech'
    )
    assert.equal(
      buildAudioSpeechUrl('https://proxy.example.com/'),
      'https://proxy.example.com/v1/audio/speech'
    )
    assert.equal(
      buildAudioTranscriptionsUrl('https://api.groq.com/openai/v1/audio/transcriptions'),
      'https://api.groq.com/openai/v1/audio/transcriptions'
    )
    assert.equal(
      buildOpenRouterSpeechModelsUrl('https://openrouter.ai/api/v1'),
      'https://openrouter.ai/api/v1/audio/speech/models'
    )
    assert.equal(isOpenRouterUrl('https://openrouter.ai/api/v1'), true)
    assert.equal(isOpenRouterUrl('https://api.siliconflow.cn/v1'), false)
  })

  it('omits speed when equal to 1.0 and includes speed otherwise', () => {
    const defaultBody = buildOpenAiTtsRequestBody({
      model: 'gpt-4o-mini-tts',
      input: 'hello',
      voice: 'coral',
      speed: 1.0,
    })
    assert.equal('speed' in defaultBody, false)
    assert.equal(defaultBody.response_format, 'mp3')

    const fastBody = buildOpenAiTtsRequestBody({
      model: 'gpt-4o-mini-tts',
      input: 'hello',
      voice: 'coral',
      speed: 1.4,
      responseFormat: 'pcm',
    })
    assert.equal(fastBody.speed, 1.4)
    assert.equal(fastBody.response_format, 'pcm')
    assert.equal(speedToEdgeRate(1.2), '+20%')
    assert.equal(speedToEdgeRate(0.8), '-20%')
  })

  it('detects 400 unsupported mp3 errors for automatic pcm retry', () => {
    assert.equal(
      shouldRetryOpenAiTtsAsPcm(400, '{"error":"Only pcm response_format is supported"}'),
      true
    )
    assert.equal(shouldRetryOpenAiTtsAsPcm(400, '{"error":"mp3 format is not supported"}'), true)
    assert.equal(shouldRetryOpenAiTtsAsPcm(401, 'Invalid token'), false)
    assert.equal(shouldRetryOpenAiTtsAsPcm(400, 'Input text is empty'), false)
  })

  it('parses OpenRouter /audio/speech/models voices for both model and endpoint modalities', () => {
    const sample = JSON.stringify({
      data: [
        {
          id: 'google/gemini-3.8-flash-lite-tts',
          output_modalities: [
            {
              type: 'speech',
              supported_parameters: {
                voice: { type: 'enum', values: ['Kore', 'Aoede', 'Puck'] },
              },
            },
          ],
        },
        {
          id: 'qwen/qwen3-tts-1.7b',
          endpoints: [
            {
              output_modalities: [
                {
                  type: 'speech',
                  supported_parameters: {
                    voice: { type: 'enum', values: ['vivian', 'serena'] },
                  },
                },
              ],
            },
          ],
        },
      ],
    })

    assert.deepEqual(parseOpenRouterSpeechVoices(sample, 'google/gemini-3.8-flash-lite-tts'), [
      'Kore',
      'Aoede',
      'Puck',
    ])
    assert.deepEqual(parseOpenRouterSpeechVoices(sample, 'qwen/qwen3-tts-1.7b'), [
      'vivian',
      'serena',
    ])
  })

  it('parses OpenAI compatible ASR JSON and plain text responses', () => {
    assert.equal(parseAsrResponseText('{"text":"你好世界"}', 'application/json'), '你好世界')
    assert.equal(
      parseAsrResponseText('{"data":{"text":"nested result"}}', 'application/json'),
      'nested result'
    )
    assert.equal(parseAsrResponseText('plain transcript', 'text/plain'), 'plain transcript')
  })
})

describe('Edge voice filtering and localization mapping', () => {
  it('filters curated voices by language and search query without middle dots', () => {
    const zhOnly = filterVoices(CURATED_EDGE_VOICES, 'zh', '')
    assert.ok(zhOnly.every((v) => v.lang === 'zh'))
    assert.ok(zhOnly.some((v) => v.id === 'zh-CN-XiaoxiaoNeural' && v.name === '晓晓'))

    const cantonese = filterVoices(CURATED_EDGE_VOICES, 'all', '粤语')
    assert.equal(cantonese.length, 1)
    assert.equal(cantonese[0].id, 'zh-HK-HiuMaanNeural')

    const enMatch = filterVoices(CURATED_EDGE_VOICES, 'en', 'emma')
    assert.equal(enMatch.length, 1)
    assert.equal(enMatch[0].name, 'Emma')

    for (const v of CURATED_EDGE_VOICES) {
      assert.equal(v.meta.includes('·'), false)
      assert.equal(v.name.includes('·'), false)
    }
  })

  it('parses Microsoft voice list JSON cleanly without middle dots', () => {
    const raw = JSON.stringify([
      { ShortName: 'ja-JP-NanamiNeural', Locale: 'ja-JP', Gender: 'Female' },
      { ShortName: 'zh-CN-XiaoxiaoNeural', Locale: 'zh-CN', Gender: 'Female' },
      { ShortName: 'zh-CN-liaoning-XiaobeiNeural', Locale: 'zh-CN-liaoning', Gender: 'Female' },
    ])
    const parsed = parseEdgeVoicesJson(raw, true)
    assert.equal(parsed[0].id, 'zh-CN-XiaoxiaoNeural')
    assert.equal(parsed[0].name, '晓晓')
    assert.equal(parsed[0].meta, '普通话 女声')
    const liaoning = parsed.find((v) => v.id === 'zh-CN-liaoning-XiaobeiNeural')
    assert.ok(liaoning)
    assert.equal(liaoning.name, '晓北')
    assert.equal(liaoning.meta, '东北话 女声')
    for (const v of parsed) {
      assert.equal(v.meta.includes('·'), false)
    }

    const enLocalized = localizeEdgeVoices(parsed, false)
    const xiaoxiaoEn = getEdgeVoiceById('zh-CN-XiaoxiaoNeural', enLocalized, false)
    assert.equal(xiaoxiaoEn.name, 'Xiaoxiao')
    assert.equal(xiaoxiaoEn.meta, 'Mandarin Female')
    const nanamiEn = enLocalized.find((v) => v.id === 'ja-JP-NanamiNeural')
    assert.ok(nanamiEn)
    assert.equal(nanamiEn.name, 'Nanami')
    assert.equal(nanamiEn.meta, 'Japanese Female')
  })
})

describe('Segmented TTS pipeline prefetch cancellation', () => {
  it('aborts in-flight prefetched segment and avoids unhandled rejections when current segment fails', async () => {
    const controller = new AbortController()
    let prefetchSignal: AbortSignal | undefined
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      const fakeContext = {
        currentTime: 0,
        destination: {},
        createBuffer: () => ({ copyToChannel: () => {}, duration: 0.5 }),
        createBufferSource: () => ({
          buffer: null,
          connect: () => {},
          start: () => {},
          onended: null,
        }),
      } as unknown as AudioContext

      await assert.rejects(
        playSegmentedAudioPipeline({
          segments: ['第一段', '第二段'],
          context: fakeContext,
          signal: controller.signal,
          onPlaying: () => {},
          fetchSegment: async (segment, segSignal) => {
            if (segment === '第一段') {
              await new Promise((resolve) => setTimeout(resolve, 10))
              throw new Error('segment 0 failed')
            }
            prefetchSignal = segSignal
            return await new Promise((_, reject) => {
              segSignal.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true }
              )
            })
          },
        }),
        /segment 0 failed/
      )

      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(prefetchSignal)
      assert.equal(prefetchSignal.aborted, true)
      assert.equal(unhandled.length, 0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
