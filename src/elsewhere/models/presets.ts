import type { ModelProviderConfig } from './types.js'

export const BUILTIN_DEEPSEEK_ID = 'deepseek'

const FAMILY_RULES: ReadonlyArray<readonly [string, RegExp]> = [
  ['Anthropic', /(?:^|\/)(?:claude|anthropic)/i],
  ['OpenAI', /(?:^|\/)(?:gpt-|o[134](?:-|$)|chatgpt-|openai\/|codex)/i],
  ['Google', /(?:^|\/)(?:gemini|gemma|google\/)/i],
  ['DeepSeek', /(?:^|\/)deepseek/i],
  ['Qwen', /(?:^|\/)(?:qwen|qwq)/i],
  ['Meta', /(?:^|\/)(?:llama|meta-llama)/i],
  ['xAI', /(?:^|\/)(?:grok|x-ai\/)/i],
  ['Mistral', /(?:^|\/)(?:mistral|mixtral|codestral|pixtral|ministral)/i],
  ['GLM', /(?:^|\/)(?:glm|chatglm|zhipuai\/|zai-org\/)/i],
  ['Moonshot', /(?:^|\/)(?:kimi|moonshot)/i],
  ['MiniMax', /(?:^|\/)minimax/i],
]

export const inferModelGroup = (modelId: string): string => {
  const normalized = modelId.trim()
  if (!normalized) {
    return '其他'
  }
  for (const [group, pattern] of FAMILY_RULES) {
    if (pattern.test(normalized)) {
      return group
    }
  }
  return '其他'
}

export const createDefaultProviders = (): ModelProviderConfig[] => [
  {
    id: BUILTIN_DEEPSEEK_ID,
    name: 'DeepSeek',
    builtin: true,
    format: 'messages',
    baseUrl: '',
    apiKey: '',
    enabled: true,
    models: [
      {
        id: 'deepseek-flash',
        label: 'DeepSeek Flash',
        group: 'DeepSeek',
        enabled: true,
      },
      {
        id: 'deepseek-v4-pro',
        label: 'DeepSeek V4 Pro',
        group: 'DeepSeek',
        enabled: true,
      },
    ],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    format: 'chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    enabled: false,
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    format: 'messages',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    enabled: false,
    models: [],
  },
  {
    id: 'openai',
    name: 'OpenAI',
    format: 'responses',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    enabled: false,
    models: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    format: 'chat',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    enabled: false,
    models: [],
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    format: 'chat',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    enabled: false,
    models: [],
  },
]
