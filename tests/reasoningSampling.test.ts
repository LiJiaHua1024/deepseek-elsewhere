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
  sampling: { temperature: 0.7, topP: 0.9 },
}

describe('Three-protocol reasoning effort and sampling serialization', () => {
  it('serializes Anthropic Messages with budget_tokens, raised max_tokens, and omitted sampling when thinking enabled', () => {
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

    const disabledReq = customMessagesRequest({
      ...baseBody,
      thinking: { type: 'disabled' },
      sampling: { temperature: 0.5, topP: null },
    }) as Record<string, unknown>
    assert.equal('thinking' in disabledReq, false)
    assert.equal(disabledReq.max_tokens, 4096)
    assert.equal(disabledReq.temperature, 0.5)
    assert.equal('top_p' in disabledReq, false)
  })

  it('serializes OpenAI Chat Completions reasoning_effort and optional sampling for custom endpoints', () => {
    const enabledAuto = openAIRequest('chat', baseBody, false) as Record<string, unknown>
    assert.equal(enabledAuto.reasoning_effort, 'medium')
    assert.equal(enabledAuto.temperature, 0.7)
    assert.equal(enabledAuto.top_p, 0.9)

    const enabledHigh = openAIRequest(
      'chat',
      { ...baseBody, reasoningEffort: 'high' },
      false
    ) as Record<string, unknown>
    assert.equal(enabledHigh.reasoning_effort, 'high')

    const disabled = openAIRequest(
      'chat',
      { ...baseBody, thinking: { type: 'disabled' }, sampling: { temperature: null, topP: 0.85 } },
      false
    ) as Record<string, unknown>
    assert.equal('reasoning_effort' in disabled, false)
    assert.equal('temperature' in disabled, false)
    assert.equal(disabled.top_p, 0.85)
  })

  it('serializes OpenAI Responses reasoning object and optional sampling for custom endpoints', () => {
    const enabledAuto = openAIRequest('responses', baseBody, false) as Record<string, unknown>
    assert.deepEqual(enabledAuto.reasoning, { effort: 'medium', summary: 'auto' })
    assert.equal(enabledAuto.temperature, 0.7)
    assert.equal(enabledAuto.top_p, 0.9)

    const enabledLow = openAIRequest(
      'responses',
      { ...baseBody, reasoningEffort: 'low' },
      false
    ) as Record<string, unknown>
    assert.deepEqual(enabledLow.reasoning, { effort: 'low', summary: 'auto' })

    const disabled = openAIRequest(
      'responses',
      { ...baseBody, thinking: { type: 'disabled' }, sampling: {} },
      false
    ) as Record<string, unknown>
    assert.equal('reasoning' in disabled, false)
    assert.equal('temperature' in disabled, false)
    assert.equal('top_p' in disabled, false)
  })

  it('preserves official DeepSeek protocol behavior and omits sampling when thinking enabled', () => {
    const officialMsgEnabled = JSON.parse(serializeOfficialAnthropicBody(baseBody)) as Record<
      string,
      unknown
    >
    assert.deepEqual(officialMsgEnabled.thinking, { type: 'enabled' })
    assert.equal('reasoningEffort' in officialMsgEnabled, false)
    assert.equal('temperature' in officialMsgEnabled, false)

    const officialMsgDisabled = JSON.parse(
      serializeOfficialAnthropicBody({ ...baseBody, thinking: { type: 'disabled' } })
    ) as Record<string, unknown>
    assert.equal(officialMsgDisabled.temperature, 0.7)
    assert.equal(officialMsgDisabled.top_p, 0.9)

    const officialRespAuto = openAIRequest('responses', baseBody, true) as Record<string, unknown>
    assert.deepEqual(officialRespAuto.reasoning, { effort: 'high' })
    assert.equal('temperature' in officialRespAuto, false)

    const officialRespDisabled = openAIRequest(
      'responses',
      { ...baseBody, thinking: { type: 'disabled' } },
      true
    ) as Record<string, unknown>
    assert.deepEqual(officialRespDisabled.reasoning, { effort: 'none' })
    assert.equal(officialRespDisabled.temperature, 0.7)
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
