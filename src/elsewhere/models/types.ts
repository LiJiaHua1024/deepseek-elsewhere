import type { ChatApiFormat } from '../../services/api/chatConfig.js'

export type ProviderModelItem = {
  id: string
  /** 展示名，缺省回退 id */
  label: string
  /** 管理模型时的分组名（如 Anthropic / OpenAI / Google / DeepSeek / 其他） */
  group: string
  enabled: boolean
  /** 可选：单模型上下文窗口覆盖（token），未设时沿用默认估算 */
  contextWindow?: number
}

export type ModelProviderConfig = {
  id: string
  name: string
  /** true 表示内置官方 DeepSeek 供应商，直接复用主设置 apiKey */
  builtin?: boolean
  format: ChatApiFormat
  /** 规范化后的基础地址，如 https://openrouter.ai/api/v1 */
  baseUrl: string
  apiKey: string
  enabled: boolean
  models: ProviderModelItem[]
}

export type ActiveModelRef = {
  providerId: string
  modelId: string
}

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high'

export type SamplingParams = {
  temperature?: number | null
  topP?: number | null
}
