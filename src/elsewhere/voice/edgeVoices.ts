import { create } from 'zustand'
import { fetchAndroidEdgeVoices } from '../../app/android.js'
import type { EdgeVoiceItem, SystemVoiceItem, VoiceLangFilter } from './types.js'

const EDGE_VOICES_CACHE_KEY = 'elsewhere:edge-voices-cache-v1'

export const CURATED_EDGE_VOICES: readonly EdgeVoiceItem[] = [
  {
    id: 'zh-CN-XiaoxiaoNeural',
    name: '晓晓',
    lang: 'zh',
    meta: '普通话 女声',
    locale: 'zh-CN',
    gender: 'Female',
  },
  {
    id: 'zh-CN-YunxiNeural',
    name: '云希',
    lang: 'zh',
    meta: '普通话 男声',
    locale: 'zh-CN',
    gender: 'Male',
  },
  {
    id: 'zh-CN-YunjianNeural',
    name: '云健',
    lang: 'zh',
    meta: '普通话 男声',
    locale: 'zh-CN',
    gender: 'Male',
  },
  {
    id: 'zh-CN-XiaoyiNeural',
    name: '晓伊',
    lang: 'zh',
    meta: '普通话 女声',
    locale: 'zh-CN',
    gender: 'Female',
  },
  {
    id: 'zh-CN-YunyangNeural',
    name: '云扬',
    lang: 'zh',
    meta: '普通话 男声',
    locale: 'zh-CN',
    gender: 'Male',
  },
  {
    id: 'zh-HK-HiuMaanNeural',
    name: '晓曼',
    lang: 'zh',
    meta: '粤语 女声',
    locale: 'zh-HK',
    gender: 'Female',
  },
  {
    id: 'en-US-EmmaMultilingualNeural',
    name: 'Emma',
    lang: 'en',
    meta: '英语 女声',
    locale: 'en-US',
    gender: 'Female',
  },
  {
    id: 'en-US-AndrewMultilingualNeural',
    name: 'Andrew',
    lang: 'en',
    meta: '英语 男声',
    locale: 'en-US',
    gender: 'Male',
  },
  {
    id: 'ja-JP-NanamiNeural',
    name: '七海',
    lang: 'ja',
    meta: '日语 女声',
    locale: 'ja-JP',
    gender: 'Female',
  },
  {
    id: 'ja-JP-KeitaNeural',
    name: '圭太',
    lang: 'ja',
    meta: '日语 男声',
    locale: 'ja-JP',
    gender: 'Male',
  },
]

const VOICE_NAME_ZH: Record<string, string> = {
  'zh-CN-XiaoxiaoNeural': '晓晓',
  'zh-CN-YunxiNeural': '云希',
  'zh-CN-YunjianNeural': '云健',
  'zh-CN-XiaoyiNeural': '晓伊',
  'zh-CN-YunyangNeural': '云扬',
  'zh-CN-YunxiaNeural': '云夏',
  'zh-CN-XiaochenNeural': '晓辰',
  'zh-CN-XiaohanNeural': '晓涵',
  'zh-CN-XiaomengNeural': '晓梦',
  'zh-CN-XiaomoNeural': '晓墨',
  'zh-CN-XiaoqiuNeural': '晓秋',
  'zh-CN-XiaoruiNeural': '晓睿',
  'zh-CN-XiaoshuangNeural': '晓双',
  'zh-CN-XiaoxuanNeural': '晓萱',
  'zh-CN-XiaoyanNeural': '晓颜',
  'zh-CN-XiaoyouNeural': '晓悠',
  'zh-CN-XiaozhenNeural': '晓甄',
  'zh-CN-YunfengNeural': '云枫',
  'zh-CN-YunhaoNeural': '云皓',
  'zh-CN-YunzeNeural': '云泽',
  'zh-CN-liaoning-XiaobeiNeural': '晓北',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮',
  'zh-HK-HiuMaanNeural': '晓曼',
  'zh-HK-HiuGaaiNeural': '晓佳',
  'zh-HK-WanLungNeural': '云龙',
  'zh-TW-HsiaoChenNeural': '晓臻',
  'zh-TW-HsiaoYuNeural': '晓雨',
  'zh-TW-YunJheNeural': '云哲',
  'ja-JP-NanamiNeural': '七海',
  'ja-JP-KeitaNeural': '圭太',
}

export const classifyLocaleLang = (locale: string): 'zh' | 'en' | 'ja' | 'other' => {
  const lower = locale.toLowerCase()
  if (lower.startsWith('zh')) {
    return 'zh'
  }
  if (lower.startsWith('en')) {
    return 'en'
  }
  if (lower.startsWith('ja')) {
    return 'ja'
  }
  return 'other'
}

export const formatLocaleMeta = (locale: string, gender: string, zh: boolean): string => {
  const lowerLocale = locale.toLowerCase()
  let regionLabel: string
  if (lowerLocale.startsWith('zh-hk')) {
    regionLabel = zh ? '粤语' : 'Cantonese'
  } else if (lowerLocale.startsWith('zh-tw')) {
    regionLabel = zh ? '台湾普通话' : 'Taiwanese Mandarin'
  } else if (lowerLocale.includes('liaoning')) {
    regionLabel = zh ? '东北话' : 'Liaoning Mandarin'
  } else if (lowerLocale.includes('shaanxi')) {
    regionLabel = zh ? '陕西话' : 'Shaanxi Mandarin'
  } else if (lowerLocale.startsWith('zh')) {
    regionLabel = zh ? '普通话' : 'Mandarin'
  } else if (lowerLocale.startsWith('en-gb')) {
    regionLabel = zh ? '英式英语' : 'British English'
  } else if (lowerLocale.startsWith('en')) {
    regionLabel = zh ? '英语' : 'English'
  } else if (lowerLocale.startsWith('ja')) {
    regionLabel = zh ? '日语' : 'Japanese'
  } else if (lowerLocale.startsWith('ko')) {
    regionLabel = zh ? '韩语' : 'Korean'
  } else if (lowerLocale.startsWith('fr')) {
    regionLabel = zh ? '法语' : 'French'
  } else if (lowerLocale.startsWith('de')) {
    regionLabel = zh ? '德语' : 'German'
  } else if (lowerLocale.startsWith('es')) {
    regionLabel = zh ? '西班牙语' : 'Spanish'
  } else {
    regionLabel = locale || (zh ? '未知语种' : 'Unknown')
  }

  const lowerGender = gender.toLowerCase()
  const genderLabel =
    lowerGender === 'female'
      ? zh
        ? '女声'
        : 'Female'
      : lowerGender === 'male'
        ? zh
          ? '男声'
          : 'Male'
        : ''
  return genderLabel ? `${regionLabel} ${genderLabel}` : regionLabel
}

const extractVoiceDisplayName = (shortName: string, friendlyName?: string, zh = true): string => {
  if (zh && VOICE_NAME_ZH[shortName]) {
    return VOICE_NAME_ZH[shortName]
  }
  const parts = shortName.split('-')
  const tail = parts[parts.length - 1] ?? shortName
  const cleanTail = tail.replace(/MultilingualNeural$/i, '').replace(/Neural$/i, '')
  if (cleanTail) {
    return cleanTail
  }
  if (friendlyName) {
    const match = /Microsoft\s+([^-]+?)\s+(?:Online|Multilingual)/i.exec(friendlyName)
    if (match?.[1]) {
      return match[1].trim()
    }
  }
  return shortName
}

export const localizeEdgeVoice = (
  voice: Pick<EdgeVoiceItem, 'id' | 'locale' | 'gender' | 'lang'>,
  zh: boolean
): EdgeVoiceItem => ({
  id: voice.id,
  name: extractVoiceDisplayName(voice.id, undefined, zh),
  lang: voice.lang ?? classifyLocaleLang(voice.locale || voice.id),
  meta: formatLocaleMeta(
    voice.locale || voice.id.split('-').slice(0, 2).join('-'),
    voice.gender,
    zh
  ),
  locale: voice.locale,
  gender: voice.gender,
})

export const localizeEdgeVoices = (
  voices: readonly EdgeVoiceItem[],
  zh: boolean
): EdgeVoiceItem[] => voices.map((voice) => localizeEdgeVoice(voice, zh))

export const parseEdgeVoicesJson = (rawJson: string, zh = true): EdgeVoiceItem[] => {
  const parsed: unknown = JSON.parse(rawJson)
  if (!Array.isArray(parsed)) {
    return localizeEdgeVoices(CURATED_EDGE_VOICES, zh)
  }
  const curatedOrder = new Map(CURATED_EDGE_VOICES.map((item, idx) => [item.id, idx]))
  const seen = new Set<string>()
  const result: EdgeVoiceItem[] = []
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') {
      continue
    }
    const obj = entry as Record<string, unknown>
    const id = typeof obj.ShortName === 'string' ? obj.ShortName.trim() : ''
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    const locale = typeof obj.Locale === 'string' ? obj.Locale.trim() : ''
    const gender = typeof obj.Gender === 'string' ? obj.Gender.trim() : ''
    const friendly = typeof obj.FriendlyName === 'string' ? obj.FriendlyName : undefined
    result.push({
      id,
      name: extractVoiceDisplayName(id, friendly, zh),
      lang: classifyLocaleLang(locale),
      meta: formatLocaleMeta(locale, gender, zh),
      locale,
      gender,
    })
  }
  if (result.length === 0) {
    return localizeEdgeVoices(CURATED_EDGE_VOICES, zh)
  }
  result.sort((a, b) => {
    const ca = curatedOrder.get(a.id)
    const cb = curatedOrder.get(b.id)
    if (ca !== undefined && cb !== undefined) {
      return ca - cb
    }
    if (ca !== undefined) {
      return -1
    }
    if (cb !== undefined) {
      return 1
    }
    const rank = (lang: EdgeVoiceItem['lang']) =>
      lang === 'zh' ? 0 : lang === 'en' ? 1 : lang === 'ja' ? 2 : 3
    const diff = rank(a.lang) - rank(b.lang)
    if (diff !== 0) {
      return diff
    }
    return a.id.localeCompare(b.id)
  })
  return result
}

type CachedEdgeVoiceEntry = {
  id: string
  locale: string
  gender: string
  lang: EdgeVoiceItem['lang']
}

const loadCachedEdgeVoices = (): EdgeVoiceItem[] => {
  try {
    if (typeof localStorage === 'undefined') {
      return [...CURATED_EDGE_VOICES]
    }
    const raw = localStorage.getItem(EDGE_VOICES_CACHE_KEY)
    if (!raw) {
      return [...CURATED_EDGE_VOICES]
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [...CURATED_EDGE_VOICES]
    }
    const entries: EdgeVoiceItem[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') {
        continue
      }
      const obj = item as Record<string, unknown>
      const id = typeof obj.id === 'string' ? obj.id.trim() : ''
      if (!id) {
        continue
      }
      const locale = typeof obj.locale === 'string' ? obj.locale : ''
      const gender = typeof obj.gender === 'string' ? obj.gender : ''
      const lang =
        obj.lang === 'zh' || obj.lang === 'en' || obj.lang === 'ja' || obj.lang === 'other'
          ? obj.lang
          : classifyLocaleLang(locale || id)
      entries.push(localizeEdgeVoice({ id, locale, gender, lang }, true))
    }
    return entries.length > 0 ? entries : [...CURATED_EDGE_VOICES]
  } catch {
    return [...CURATED_EDGE_VOICES]
  }
}

export const useEdgeVoicesStore = create<{
  voices: EdgeVoiceItem[]
  loading: boolean
}>(() => ({
  voices: loadCachedEdgeVoices(),
  loading: false,
}))

export const refreshEdgeVoicesList = async (signal?: AbortSignal): Promise<EdgeVoiceItem[]> => {
  useEdgeVoicesStore.setState({ loading: true })
  try {
    const rawJson = await fetchAndroidEdgeVoices(signal)
    const voices = parseEdgeVoicesJson(rawJson, true)
    const cacheEntries: CachedEdgeVoiceEntry[] = voices.map(({ id, locale, gender, lang }) => ({
      id,
      locale,
      gender,
      lang,
    }))
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(EDGE_VOICES_CACHE_KEY, JSON.stringify(cacheEntries))
      }
    } catch {
      // Ignore quota errors on voice cache.
    }
    useEdgeVoicesStore.setState({ voices, loading: false })
    return voices
  } catch (error) {
    useEdgeVoicesStore.setState({ loading: false })
    throw error
  }
}

export const getEdgeVoiceById = (
  id: string,
  voices: readonly EdgeVoiceItem[] = useEdgeVoicesStore.getState().voices,
  zh = true
): EdgeVoiceItem => {
  const found =
    voices.find((item) => item.id === id) ?? CURATED_EDGE_VOICES.find((item) => item.id === id)
  if (found) {
    return localizeEdgeVoice(found, zh)
  }
  return localizeEdgeVoice(
    {
      id,
      locale: id.split('-').slice(0, 2).join('-'),
      gender: '',
      lang: classifyLocaleLang(id),
    },
    zh
  )
}

export const filterVoices = <
  T extends { id: string; name: string; lang: 'zh' | 'en' | 'ja' | 'other'; meta: string },
>(
  voices: readonly T[],
  langFilter: VoiceLangFilter,
  query: string
): T[] => {
  const q = query.trim().toLowerCase()
  return voices.filter((voice) => {
    if (langFilter !== 'all' && voice.lang !== langFilter) {
      return false
    }
    if (!q) {
      return true
    }
    return (
      voice.name.toLowerCase().includes(q) ||
      voice.meta.toLowerCase().includes(q) ||
      voice.id.toLowerCase().includes(q)
    )
  })
}

export const formatSystemVoiceItem = (
  raw: { id: string; name: string; locale: string; network?: boolean },
  zh: boolean
): SystemVoiceItem => {
  const lang = classifyLocaleLang(raw.locale)
  const regionMeta = formatLocaleMeta(raw.locale, '', zh)
  const suffix = raw.network ? (zh ? '在线' : 'Network') : zh ? '本地' : 'Local'
  return {
    id: raw.id,
    name: raw.name,
    locale: raw.locale,
    lang,
    meta: raw.locale ? `${regionMeta} ${suffix}` : suffix,
    network: raw.network,
  }
}
