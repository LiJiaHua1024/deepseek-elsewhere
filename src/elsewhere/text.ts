import { android } from '../app/android.js'
import { useSettings, type Locale } from '../services/settings.js'

export const TOP_UP_URL = 'https://platform.deepseek.com/top_up'

export const externalLinkProps = () =>
  android
    ? { href: TOP_UP_URL }
    : { href: TOP_UP_URL, target: '_blank', rel: 'noopener noreferrer' }

export const useIsZh = (): boolean => useSettings((state) => state.locale === 'zh-CN')

export const pickText = <T,>(locale: Locale, zhText: T, enText: T): T =>
  locale === 'zh-CN' ? zhText : enText

export const formatUpdatedTime = (timestampMs: number, locale: Locale): string => {
  const diffMs = Date.now() - timestampMs
  if (diffMs < 60_000) {
    return pickText(locale, '刚刚更新', 'Just now')
  }
  const date = new Date(timestampMs)
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return pickText(locale, `更新于 ${hh}:${mm}`, `Updated ${hh}:${mm}`)
}
