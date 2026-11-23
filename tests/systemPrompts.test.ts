import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildRequestSystemPrompt, resolveEffectivePrompt } from '../src/elsewhere/prompts/config.js'
import { createBuiltinPromptPresets } from '../src/elsewhere/prompts/presets.js'
import { toSessionFile } from '../src/services/chat/history/toArchive.js'
import { toLocalSession } from '../src/services/chat/history/toLocal.js'
import { mergeSessions } from '../src/services/chat/history/mergeSessions.js'
import type { Session } from '../src/services/chat/types.js'

const OFFICIAL_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

describe('Custom system instructions and priority rules', () => {
  it('provides 3 built-in behavioral contract presets', () => {
    const presets = createBuiltinPromptPresets()
    assert.deepEqual(
      presets.map((item) => item.name),
      ['直白克制', '严谨核查', '启发学习']
    )
    assert.ok(presets.every((item) => item.content.length > 50))
  })

  it('never injects DeepSeek identity on custom endpoints when no instruction is active', () => {
    const fixedNow = new Date(2026, 10, 23, 18, 30)
    const customEmpty = buildRequestSystemPrompt({
      customEndpoint: true,
      officialDefaultPrompt: OFFICIAL_PROMPT,
      effectivePromptContent: '',
      now: fixedNow,
    })
    assert.equal(customEmpty.includes('DeepSeek'), false)
    assert.equal(customEmpty.includes('深度求索'), false)
    assert.match(customEmpty, /^Current local date and time: 2026-11-23 18:30/)

    const customWithPreset = buildRequestSystemPrompt({
      customEndpoint: true,
      officialDefaultPrompt: OFFICIAL_PROMPT,
      effectivePromptContent: '直接给出结论。',
      now: fixedNow,
    })
    assert.ok(customWithPreset.startsWith('直接给出结论。\n\nCurrent local date and time:'))
    assert.equal(customWithPreset.includes('深度求索'), false)
  })

  it('uses official default identity when no preset is active and replaces it when preset is active', () => {
    const officialDefault = buildRequestSystemPrompt({
      customEndpoint: false,
      officialDefaultPrompt: OFFICIAL_PROMPT,
      effectivePromptContent: '',
    })
    assert.equal(officialDefault, OFFICIAL_PROMPT)

    const officialCustom = buildRequestSystemPrompt({
      customEndpoint: false,
      officialDefaultPrompt: OFFICIAL_PROMPT,
      effectivePromptContent: '只给核心结论。',
    })
    assert.equal(officialCustom, '只给核心结论。')
  })

  it('resolves session overrides (follow / none / preset) over global default and handles deleted presets', () => {
    const presets = createBuiltinPromptPresets()
    const direct = presets[0]
    const socratic = presets[2]

    assert.deepEqual(resolveEffectivePrompt(presets, null, undefined), {
      preset: null,
      isCustomActive: false,
    })
    assert.deepEqual(resolveEffectivePrompt(presets, direct.id, { mode: 'follow' }), {
      preset: direct,
      isCustomActive: true,
    })
    assert.deepEqual(resolveEffectivePrompt(presets, direct.id, { mode: 'none' }), {
      preset: null,
      isCustomActive: false,
    })
    assert.deepEqual(
      resolveEffectivePrompt(presets, direct.id, { mode: 'preset', presetId: socratic.id }),
      {
        preset: socratic,
        isCustomActive: true,
      }
    )
    assert.deepEqual(
      resolveEffectivePrompt(presets, direct.id, { mode: 'preset', presetId: 'deleted-id' }),
      {
        preset: direct,
        isCustomActive: true,
      }
    )
  })

  it('preserves local session metadata across mergeSessions and omits secrets/metadata from archive export', () => {
    const now = 1_760_000_000_000
    const local: Session = {
      id: 'sess-1',
      title: 'Test session',
      createdAt: now,
      updatedAt: now + 1000,
      modelRef: { providerId: 'anthropic', modelId: 'claude-sonnet-4-5' },
      promptOverride: { mode: 'preset', presetId: 'builtin-direct' },
      reasoningEffort: 'high',
      sampling: { temperature: 0.3, topP: 0.9 },
      messages: [
        { id: 'm1', role: 'user', content: 'Hi', files: [], createdAt: now },
        {
          id: 'm2',
          role: 'assistant',
          createdAt: now + 500,
          model: 'claude-sonnet-4-5',
          prefix: false,
          status: 'done',
          blocks: [{ type: 'text', text: 'Hello!' }],
        },
      ],
    }

    const exported = toSessionFile(local, () => null, false)
    assert.equal('modelRef' in exported, false)
    assert.equal('promptOverride' in exported, false)

    const imported = toLocalSession({
      ...exported,
      createdAt: now,
      updatedAt: now + 2000,
      messages: exported.messages.map((m, idx) => ({
        ...m,
        createdAt: now + idx * 500,
      })),
    }).session

    const merged = mergeSessions(local, imported)
    assert.deepEqual(merged.session.modelRef, local.modelRef)
    assert.deepEqual(merged.session.promptOverride, local.promptOverride)
    assert.equal(merged.session.reasoningEffort, 'high')
    assert.deepEqual(merged.session.sampling, { temperature: 0.3, topP: 0.9 })
  })
})
