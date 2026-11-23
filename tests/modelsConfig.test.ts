import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  migrateLegacyChatConfig,
  resolveChatConfigFromProviders,
  selectActiveModel,
  toggleProviderModel,
  addManualModel,
  useModelProviders,
} from '../src/elsewhere/models/config.js'
import {
  buildModelsUrl,
  buildProviderModelsHeaders,
  fetchProviderModels,
  mergeFetchedModels,
  parseModelsResponse,
} from '../src/elsewhere/models/fetchModels.js'
import { BUILTIN_DEEPSEEK_ID, inferModelGroup } from '../src/elsewhere/models/presets.js'
import { DEFAULT_CHAT_CONFIG } from '../src/services/api/chatConfig.js'
import { useSettings } from '../src/services/settings.js'

describe('Multi-provider migration and chatConfig sync', () => {
  it('migrates legacy custom endpoint matching a preset and preserves key, format, and model', () => {
    const migrated = migrateLegacyChatConfig({
      model: 'anthropic/claude-sonnet-4.5',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      format: 'chat',
      apiKey: 'sk-or-test-123',
    })

    assert.equal(migrated.activeModel.providerId, 'openrouter')
    assert.equal(migrated.activeModel.modelId, 'anthropic/claude-sonnet-4.5')

    const openrouter = migrated.providers.find((item) => item.id === 'openrouter')
    assert.ok(openrouter)
    assert.equal(openrouter.enabled, true)
    assert.equal(openrouter.apiKey, 'sk-or-test-123')
    assert.equal(openrouter.format, 'chat')
    assert.ok(
      openrouter.models.some((item) => item.id === 'anthropic/claude-sonnet-4.5' && item.enabled)
    )
  })

  it('migrates unmatched custom endpoint into a new enabled custom provider', () => {
    const migrated = migrateLegacyChatConfig({
      model: 'claude-3-7-sonnet',
      endpoint: 'https://proxy.example.com/anthropic/v1/messages',
      format: 'messages',
      apiKey: 'sk-custom-456',
    })

    assert.equal(migrated.activeModel.providerId, 'migrated-custom')
    assert.equal(migrated.activeModel.modelId, 'claude-3-7-sonnet')
    const custom = migrated.providers.find((item) => item.id === 'migrated-custom')
    assert.ok(custom)
    assert.equal(custom.name, 'proxy.example.com')
    assert.equal(custom.baseUrl, 'https://proxy.example.com/anthropic/v1')
    assert.equal(custom.enabled, true)
    assert.equal(custom.apiKey, 'sk-custom-456')
  })

  it('keeps builtin DeepSeek active when legacy endpoint is empty', () => {
    const migrated = migrateLegacyChatConfig({
      model: 'deepseek-pro',
      endpoint: '',
      format: 'responses',
      apiKey: '',
    })

    assert.equal(migrated.activeModel.providerId, BUILTIN_DEEPSEEK_ID)
    assert.equal(migrated.activeModel.modelId, 'deepseek-pro')
    const deepseek = migrated.providers.find((item) => item.id === BUILTIN_DEEPSEEK_ID)
    assert.ok(deepseek)
    assert.equal(deepseek.format, 'responses')
    assert.equal(deepseek.enabled, true)
  })

  it('resolves official endpoint as empty string and third-party endpoints completely', () => {
    const { providers } = migrateLegacyChatConfig({
      model: 'claude-sonnet-4-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
      format: 'messages',
      apiKey: 'sk-ant-789',
    })

    const official = resolveChatConfigFromProviders(providers, {
      providerId: BUILTIN_DEEPSEEK_ID,
      modelId: 'deepseek-flash',
    })
    assert.deepEqual(official, {
      model: 'deepseek-flash',
      endpoint: '',
      format: 'messages',
      apiKey: '',
    })

    const thirdParty = resolveChatConfigFromProviders(providers, {
      providerId: 'anthropic',
      modelId: 'claude-sonnet-4-5',
    })
    assert.deepEqual(thirdParty, {
      model: 'claude-sonnet-4-5',
      endpoint: 'https://api.anthropic.com/v1/messages',
      format: 'messages',
      apiKey: 'sk-ant-789',
    })
  })

  it('synchronizes useSettings.chatConfig when switching active models', () => {
    const store = new Map<string, string>()
    const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, String(value))
        },
        removeItem: (key: string) => {
          store.delete(key)
        },
        clear: () => store.clear(),
      },
    })
    try {
      addManualModel('openai', { id: 'gpt-5', label: 'GPT-5' })
      toggleProviderModel('openai', 'gpt-5', true)
      const switched = selectActiveModel({ providerId: 'openai', modelId: 'gpt-5' })
      assert.equal(switched, true)
      assert.equal(useModelProviders.getState().activeModel.providerId, 'openai')
      assert.equal(useSettings.getState().chatConfig.endpoint, 'https://api.openai.com/v1/responses')
      assert.equal(useSettings.getState().chatConfig.model, 'gpt-5')

      const backToOfficial = selectActiveModel({
        providerId: BUILTIN_DEEPSEEK_ID,
        modelId: 'deepseek-flash',
      })
      assert.equal(backToOfficial, true)
      assert.equal(useSettings.getState().chatConfig.endpoint, DEFAULT_CHAT_CONFIG.endpoint)
      assert.equal(useSettings.getState().chatConfig.apiKey, '')
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'localStorage', originalDescriptor)
      }
    }
  })
})

describe('/models URL, auth headers, parsing, and merging', () => {
  it('builds normalized /models URLs including Anthropic /v1 auto-completion', () => {
    assert.equal(
      buildModelsUrl('https://api.anthropic.com', 'messages'),
      'https://api.anthropic.com/v1/models'
    )
    assert.equal(
      buildModelsUrl('https://api.anthropic.com/v1/messages', 'messages'),
      'https://api.anthropic.com/v1/models'
    )
    assert.equal(
      buildModelsUrl('https://openrouter.ai/api/v1/', 'chat'),
      'https://openrouter.ai/api/v1/models'
    )
    assert.equal(
      buildModelsUrl('https://generativelanguage.googleapis.com/v1beta/openai', 'chat'),
      'https://generativelanguage.googleapis.com/v1beta/openai/models'
    )
  })

  it('sends Anthropic headers for api.anthropic.com and Bearer for others', () => {
    const antHeaders = buildProviderModelsHeaders(
      'https://api.anthropic.com/v1/models',
      'messages',
      'sk-ant-key'
    )
    assert.equal(antHeaders['x-api-key'], 'sk-ant-key')
    assert.equal(antHeaders['anthropic-version'], '2023-06-01')
    assert.equal(antHeaders.Authorization, undefined)

    const orHeaders = buildProviderModelsHeaders(
      'https://openrouter.ai/api/v1/models',
      'chat',
      'sk-or-key'
    )
    assert.equal(orHeaders.Authorization, 'Bearer sk-or-key')
    assert.equal(orHeaders['x-api-key'], undefined)
  })

  it('parses both { data } and { models } payloads, groups families, and preserves enabled flags', async () => {
    const dataParsed = parseModelsResponse({
      data: [
        { id: 'anthropic/claude-sonnet-4.5', display_name: 'Claude Sonnet 4.5', context_length: 200000 },
        { id: 'openai/gpt-4o', context_window: 128000 },
        { id: 'qwen/qwen-2.5-72b' },
      ],
    })
    assert.equal(dataParsed.length, 3)
    assert.equal(dataParsed[0].group, 'Anthropic')
    assert.equal(dataParsed[0].label, 'Claude Sonnet 4.5')
    assert.equal(dataParsed[0].contextWindow, 200000)
    assert.equal(dataParsed[1].group, 'OpenAI')
    assert.equal(dataParsed[2].group, 'Qwen')
    assert.equal(inferModelGroup('custom-local-model'), '其他')

    const modelsParsed = parseModelsResponse({
      models: [{ name: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576 }],
    })
    assert.equal(modelsParsed.length, 1)
    assert.equal(modelsParsed[0].group, 'Google')
    assert.equal(modelsParsed[0].contextWindow, 1048576)

    const merged = mergeFetchedModels(
      [
        { id: 'openai/gpt-4o', label: 'My GPT-4o', group: 'OpenAI', enabled: true },
        { id: 'manual-model', label: 'Manual', group: '其他', enabled: true },
      ],
      dataParsed
    )
    assert.equal(merged.find((item) => item.id === 'openai/gpt-4o')?.enabled, true)
    assert.equal(merged.find((item) => item.id === 'openai/gpt-4o')?.label, 'My GPT-4o')
    assert.equal(merged.find((item) => item.id === 'openai/gpt-4o')?.contextWindow, 128000)
    assert.equal(merged.find((item) => item.id === 'manual-model')?.enabled, true)
    assert.equal(merged.find((item) => item.id === 'qwen/qwen-2.5-72b')?.enabled, false)

    const fetched = await fetchProviderModels(
      { baseUrl: 'https://api.example.com/v1', format: 'chat', apiKey: 'sk-test' },
      {
        transport: async () => ({
          ok: true,
          status: 200,
          contentType: 'application/json',
          text: JSON.stringify({ data: [{ id: 'deepseek-chat' }] }),
        }),
      }
    )
    assert.equal(fetched.ok, true)
    if (fetched.ok) {
      assert.equal(fetched.models[0].group, 'DeepSeek')
    }
  })
})
