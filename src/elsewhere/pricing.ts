import { DEFAULT_CHAT_MODEL } from '../services/api/chatConfig.js'
import type { AssistantMessage, Message } from '../services/chat/types.js'

type RateTier = {
  cacheHit: number
  cacheMiss: number
  output: number
}

type CurrencyRates = {
  offPeak: RateTier
  peak: RateTier
}

type ModelPricing = {
  CNY: CurrencyRates
  USD: CurrencyRates
}

/**
 * DeepSeek 官方模型公开定价（单位：每百万 tokens）。
 * 依据 https://api-docs.deepseek.com/zh-cn/quick_start/pricing 与 /quick_start/pricing
 */
const FLASH_PRICING: ModelPricing = {
  CNY: {
    offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  },
  USD: {
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  },
}

const PRO_PRICING: ModelPricing = {
  CNY: {
    offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
  },
  USD: {
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
  },
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'deepseek-flash': FLASH_PRICING,
  'deepseek-v4-flash': FLASH_PRICING,
  'deepseek-v4-flash-vision-exp': FLASH_PRICING,
  'deepseek-v4-pro': PRO_PRICING,
  'deepseek-pro': PRO_PRICING,
}

const resolveModelPricing = (model: string | null, isCustomEndpoint: boolean): ModelPricing | null => {
  const raw = model?.trim() || (isCustomEndpoint ? '' : DEFAULT_CHAT_MODEL)
  if (!raw) {
    return null
  }
  return MODEL_PRICING[raw.toLowerCase()] ?? null
}

/**
 * 按北京时间（UTC+8）判断高峰时段：工作日 09:00–12:00、14:00–18:00 为高峰。
 * （无法离线枚举每年动态法定节假日，按工作日口径估算并在 UI 标注仅供参考）
 */
export const isPeakHour = (timestampMs: number): boolean => {
  const cst = new Date(timestampMs + 8 * 3_600_000)
  const day = cst.getUTCDay()
  if (day === 0 || day === 6) {
    return false
  }
  const hour = cst.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export type SessionCostEstimate = {
  totalCost: number
  cacheSaved: number
  currency: 'CNY' | 'USD'
}

export const estimateSessionCost = (
  messages: Message[],
  currency: 'CNY' | 'USD',
  isCustomEndpoint: boolean
): SessionCostEstimate | null => {
  let totalCost = 0
  let cacheSaved = 0
  let pricedCount = 0

  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) {
      continue
    }
    const pricing = resolveModelPricing(message.model, isCustomEndpoint)
    if (!pricing) {
      continue
    }
    pricedCount += 1
    const rates = isPeakHour(message.createdAt) ? pricing[currency].peak : pricing[currency].offPeak
    const usage = (message as AssistantMessage).usage
    if (!usage) {
      continue
    }
    const missTokens = usage.input_tokens + usage.cache_creation_input_tokens
    const hitTokens = usage.cache_read_input_tokens
    const outputTokens = usage.output_tokens
    totalCost +=
      (missTokens * rates.cacheMiss + hitTokens * rates.cacheHit + outputTokens * rates.output) /
      1_000_000
    cacheSaved += (hitTokens * (rates.cacheMiss - rates.cacheHit)) / 1_000_000
  }

  if (pricedCount === 0) {
    return null
  }

  return { totalCost, cacheSaved, currency }
}

export const formatCurrency = (amount: number, currency: string): string => {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  if (amount > 0 && amount < 0.005) {
    return `<${symbol}0.01`
  }
  return `${symbol}${amount.toFixed(2)}`
}
