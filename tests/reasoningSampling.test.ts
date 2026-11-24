import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ApiError,
  customMessagesRequest,
  isUnsupportedThinkingParamError,
  resolveAnthropicThinkingBudget,
  serializeOfficialAnthropicBody,
} from '../src/services/api/client.js'
import { openAIRequest } from '../src/services/api/openaiChat.js'
import type { CreateMessageRequest } from '../src/services/api/types.js'

const baseBody: CreateMessageRequest = {
  model: 'test-model',
  max_tokens: 4096,
  system: 'System rule',
  messages: [{ role: 'user', content: 'Hello' }],
  thinking: { type: 'enabled' },
  reasoningEffort: 'auto',
}

describe('Three-protocol reasoning effort serialization', () => {
  it('serializes Anthropic Messages with budget_tokens and omits temperature/top_p', () => {
    assert.equal(resolveAnthropicThinkingBudget('low'), 2048)
    assert.equal(resolveAnthropicThinkingBudget('medium'), 8192)
    assert.equal(resolveAnthropicThinkingBudget('auto'), 8192)
    assert.equal(resolveAnthropicThinkingBudget('high'), 16384)

    const lowReq = customMessagesRequest({ ...baseBody, reasoningEffort: 'low' }) as Record<
      string,
      unknown
    >
    assert.deepEqual(lowReq.thinking, { type: 'enabled', budget_tokens: 2048 })
    assert.equal(lowReq.max_tokens, 6144)
    assert.equal('temperature' in lowReq, false)
    assert.equal('top_p' in lowReq, false)

    const highReq = customMessagesRequest({ ...baseBody, reasoningEffort: 'high' }) as Record<
      string,
      unknown
    >
    assert.deepEqual(highReq.thinking, { type: 'enabled', budget_tokens: 16384 })
    assert.equal(highReq.max_tokens, 20480)
    assert.equal('temperature' in highReq, false)
    assert.equal('top_p' in highReq, false)

    const disabledReq = customMessagesRequest({
      ...baseBody,
      thinking: { type: 'disabled' },
    }) as Record<string, unknown>
    assert.equal('thinking' in disabledReq, false)
    assert.equal(disabledReq.max_tokens, 4096)
    assert.equal('temperature' in disabledReq, false)
    assert.equal('top_p' in disabledReq, false)
  })

  it('serializes OpenAI Chat Completions reasoning_effort and omits temperature/top_p', () => {
    const enabledAuto = openAIRequest('chat', baseBody, false) as Record<string, unknown>
    assert.equal(enabledAuto.reasoning_effort, 'medium')
    assert.equal('temperature' in enabledAuto, false)
    assert.equal('top_p' in enabledAuto, false)

    const enabledHigh = openAIRequest(
      'chat',
      { ...baseBody, reasoningEffort: 'high' },
      false
    ) as Record<string, unknown>
    assert.equal(enabledHigh.reasoning_effort, 'high')

    const disabled = openAIRequest(
      'chat',
      { ...baseBody, thinking: { type: 'disabled' } },
      false
    ) as Record<string, unknown>
    assert.equal('reasoning_effort' in disabled, false)
    assert.equal('temperature' in disabled, false)
    assert.equal('top_p' in disabled, false)
  })

  it('serializes OpenAI Responses reasoning object and omits temperature/top_p', () => {
    const enabledAuto = openAIRequest('responses', baseBody, false) as Record<string, unknown>
    assert.deepEqual(enabledAuto.reasoning, { effort: 'medium', summary: 'auto' })
    assert.equal('temperature' in enabledAuto, false)
    assert.equal('top_p' in enabledAuto, false)

    const enabledLow = openAIRequest(
      'responses',
      { ...baseBody, reasoningEffort: 'low' },
      false
    ) as Record<string, unknown>
    assert.deepEqual(enabledLow.reasoning, { effort: 'low', summary: 'auto' })

    const disabled = openAIRequest(
      'responses',
      { ...baseBody, thinking: { type: 'disabled' } },
      false
    ) as Record<string, unknown>
    assert.equal('reasoning' in disabled, false)
    assert.equal('temperature' in disabled, false)
    assert.equal('top_p' in disabled, false)
  })

  it('preserves official DeepSeek protocol behavior without emitting temperature/top_p', () => {
    const officialMsgEnabled = JSON.parse(serializeOfficialAnthropicBody(baseBody)) as Record<
      string,
      unknown
    >
    assert.deepEqual(officialMsgEnabled.thinking, { type: 'enabled' })
    assert.equal('reasoningEffort' in officialMsgEnabled, false)
    assert.equal('temperature' in officialMsgEnabled, false)
    assert.equal('top_p' in officialMsgEnabled, false)

    const officialMsgDisabled = JSON.parse(
      serializeOfficialAnthropicBody({ ...baseBody, thinking: { type: 'disabled' } })
    ) as Record<string, unknown>
    assert.equal('temperature' in officialMsgDisabled, false)
    assert.equal('top_p' in officialMsgDisabled, false)

    const officialRespAuto = openAIRequest('responses', baseBody, true) as Record<string, unknown>
    assert.deepEqual(officialRespAuto.reasoning, { effort: 'high' })
    assert.equal('temperature' in officialRespAuto, false)
    assert.equal('top_p' in officialRespAuto, false)

    const officialRespDisabled = openAIRequest(
      'responses',
      { ...baseBody, thinking: { type: 'disabled' } },
      true
    ) as Record<string, unknown>
    assert.deepEqual(officialRespDisabled.reasoning, { effort: 'none' })
    assert.equal('temperature' in officialRespDisabled, false)
    assert.equal('top_p' in officialRespDisabled, false)
  })

  it('detects 400 errors pointing to unsupported thinking/reasoning parameters only', () => {
    assert.equal(
      isUnsupportedThinkingParamError(
        new ApiError('http', 'Unrecognized request argument supplied: reasoning_effort', 400)
      ),
      true
    )
    assert.equal(
      isUnsupportedThinkingParamError(
        new ApiError('http', 'thinking: Extra inputs are not permitted', 400)
      ),
      true
    )
    assert.equal(
      isUnsupportedThinkingParamError(
        new ApiError('http', 'Unsupported parameter: reasoning.effort', 400)
      ),
      true
    )
    assert.equal(
      isUnsupportedThinkingParamError(
        new ApiError('http', 'This model does not support budget_tokens', 400)
      ),
      true
    )
    assert.equal(
      isUnsupportedThinkingParamError(new ApiError('http', 'maximum context length exceeded', 400)),
      false
    )
    assert.equal(
      isUnsupportedThinkingParamError(new ApiError('http', 'reasoning_effort', 500)),
      false
    )
  })
})
