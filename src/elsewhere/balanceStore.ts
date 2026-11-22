import { create } from 'zustand'
import { android } from '../app/android.js'
import { API_ORIGIN } from '../services/api/client.js'
import { useSettings, type Locale } from '../services/settings.js'

export type BalanceInfo = {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

export type BalanceSnapshot = {
  keyFingerprint: string
  isAvailable: boolean
  balanceInfos: BalanceInfo[]
  updatedAt: number
}

type BalanceResponse = {
  is_available?: unknown
  balance_infos?: unknown
}

type NativeBalanceEvent = {
  id: string
  ok: boolean
  status: number
  body: string
}

const BALANCE_STORAGE_KEY = 'elsewhere:official-balance'
const REFRESH_INTERVAL_MS = 60_000
const REPLY_DEBOUNCE_MS = 3_000
const NATIVE_TIMEOUT_MS = 15_000
const LOW_CNY_THRESHOLD = 2.0
const LOW_USD_THRESHOLD = 0.3

const fingerprintApiKey = (apiKey: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < apiKey.length; i++) {
    hash ^= apiKey.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `${(hash >>> 0).toString(16).padStart(8, '0')}:${apiKey.length}`
}

const parseBalanceInfo = (raw: unknown): BalanceInfo | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const item = raw as Record<string, unknown>
  if (typeof item.currency !== 'string' || typeof item.total_balance !== 'string') {
    return null
  }
  return {
    currency: item.currency.toUpperCase(),
    total_balance: item.total_balance,
    granted_balance: typeof item.granted_balance === 'string' ? item.granted_balance : '0.00',
    topped_up_balance: typeof item.topped_up_balance === 'string' ? item.topped_up_balance : '0.00',
  }
}

const readStoredSnapshot = (expectedFingerprint: string | null): BalanceSnapshot | null => {
  if (!expectedFingerprint) {
    return null
  }
  try {
    const raw = localStorage.getItem(BALANCE_STORAGE_KEY)
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as Partial<BalanceSnapshot> | null
    if (
      !parsed ||
      parsed.keyFingerprint !== expectedFingerprint ||
      typeof parsed.isAvailable !== 'boolean' ||
      typeof parsed.updatedAt !== 'number' ||
      !Array.isArray(parsed.balanceInfos)
    ) {
      return null
    }
    const balanceInfos = parsed.balanceInfos
      .map(parseBalanceInfo)
      .filter((item): item is BalanceInfo => item !== null)
    return {
      keyFingerprint: parsed.keyFingerprint,
      isAvailable: parsed.isAvailable,
      balanceInfos,
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  }
}

const writeStoredSnapshot = (snapshot: BalanceSnapshot | null) => {
  try {
    if (!snapshot) {
      localStorage.removeItem(BALANCE_STORAGE_KEY)
    } else {
      localStorage.setItem(BALANCE_STORAGE_KEY, JSON.stringify(snapshot))
    }
  } catch {
    // 忽略存储异常
  }
}

type BalanceState = {
  snapshot: BalanceSnapshot | null
  loading: boolean
}

const initialKey = useSettings.getState().apiKey
const initialFingerprint = initialKey ? fingerprintApiKey(initialKey) : null

export const useBalanceStore = create<BalanceState>(() => ({
  snapshot: readStoredSnapshot(initialFingerprint),
  loading: false,
}))

let lastAttemptAt = 0
let lastReplyRefreshAt = 0
let inFlight: Promise<void> | null = null

useSettings.subscribe((state, previous) => {
  if (state.apiKey === previous.apiKey) {
    return
  }
  lastAttemptAt = 0
  if (!state.apiKey) {
    writeStoredSnapshot(null)
    useBalanceStore.setState({ snapshot: null, loading: false })
    return
  }
  const nextFingerprint = fingerprintApiKey(state.apiKey)
  const stored = readStoredSnapshot(nextFingerprint)
  useBalanceStore.setState({ snapshot: stored })
})

const parseApiPayload = (payload: unknown, keyFingerprint: string): BalanceSnapshot | null => {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const data = payload as BalanceResponse
  if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos)) {
    return null
  }
  const balanceInfos = data.balance_infos
    .map(parseBalanceInfo)
    .filter((item): item is BalanceInfo => item !== null)
  return {
    keyFingerprint,
    isAvailable: data.is_available,
    balanceInfos,
    updatedAt: Date.now(),
  }
}

const fetchViaNativeBridge = (requestOfficialBalance: (id: string) => void): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const id = `bal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let settled = false
    const cleanup = () => {
      window.clearTimeout(timer)
      window.removeEventListener('android-balance', onEvent)
    }
    const onEvent = (event: Event) => {
      const detail = (event as CustomEvent<NativeBalanceEvent>).detail
      if (!detail || detail.id !== id || settled) {
        return
      }
      settled = true
      cleanup()
      if (!detail.ok || detail.status < 200 || detail.status >= 300) {
        reject(new Error(`HTTP ${detail.status}`))
        return
      }
      try {
        resolve(JSON.parse(detail.body))
      } catch (error) {
        reject(error)
      }
    }
    const timer = window.setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      reject(new Error('Native balance request timed out'))
    }, NATIVE_TIMEOUT_MS)

    window.addEventListener('android-balance', onEvent)
    try {
      requestOfficialBalance(id)
    } catch (error) {
      if (!settled) {
        settled = true
        cleanup()
        reject(error)
      }
    }
  })

const fetchOfficialBalance = async (apiKey: string): Promise<unknown> => {
  const url = `${API_ORIGIN}/user/balance`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      credentials: 'omit',
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    return (await response.json()) as unknown
  } catch (error) {
    // 仅当浏览器/WebView 因网络或 CORS 拦截导致 fetch 抛错时，回退至 Android 原生桥接
    const bridge = android
    if (bridge?.requestOfficialBalance && error instanceof TypeError) {
      return await fetchViaNativeBridge((id) => bridge.requestOfficialBalance?.(id))
    }
    throw error
  }
}

export const refreshBalance = (options: { force?: boolean } = {}): Promise<void> => {
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    return Promise.resolve()
  }
  if (inFlight) {
    return inFlight
  }
  const force = Boolean(options.force)
  const now = Date.now()
  const { snapshot } = useBalanceStore.getState()
  const lastTouch = Math.max(lastAttemptAt, snapshot?.updatedAt ?? 0)
  if (!force && now - lastTouch < REFRESH_INTERVAL_MS) {
    return Promise.resolve()
  }

  lastAttemptAt = now
  const keyFingerprint = fingerprintApiKey(apiKey)
  useBalanceStore.setState({ loading: true })

  const task = (async () => {
    try {
      const payload = await fetchOfficialBalance(apiKey)
      const latestKey = useSettings.getState().apiKey
      if (!latestKey || fingerprintApiKey(latestKey) !== keyFingerprint) {
        return
      }
      const nextSnapshot = parseApiPayload(payload, keyFingerprint)
      if (!nextSnapshot) {
        return
      }
      writeStoredSnapshot(nextSnapshot)
      useBalanceStore.setState({ snapshot: nextSnapshot })
    } catch {
      // 请求失败时静默保留上次缓存，不清空也不弹出报错
    } finally {
      inFlight = null
      useBalanceStore.setState({ loading: false })
    }
  })()

  inFlight = task
  return task
}

export const notifyOfficialReplyFinished = () => {
  if (!useSettings.getState().apiKey) {
    return
  }
  const now = Date.now()
  if (now - lastReplyRefreshAt < REPLY_DEBOUNCE_MS) {
    return
  }
  lastReplyRefreshAt = now
  void refreshBalance({ force: true })
}

export const parseBalanceAmount = (value: string): number => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

const currencyWeight = (currency: string): number => {
  if (currency === 'CNY') {
    return 0
  }
  if (currency === 'USD') {
    return 1
  }
  return 2
}

export const getDisplayBalances = (infos: BalanceInfo[]): BalanceInfo[] => {
  const sorted = [...infos].sort(
    (a, b) => currencyWeight(a.currency) - currencyWeight(b.currency)
  )
  const positive = sorted.filter((item) => parseBalanceAmount(item.total_balance) > 0)
  if (positive.length > 0) {
    return positive
  }
  return sorted.length > 0 ? [sorted[0]] : []
}

export const isLowBalance = (snapshot: BalanceSnapshot | null): boolean => {
  if (!snapshot) {
    return false
  }
  if (!snapshot.isAvailable) {
    return true
  }
  return !snapshot.balanceInfos.some((item) => {
    const amount = parseBalanceAmount(item.total_balance)
    if (item.currency === 'CNY') {
      return amount >= LOW_CNY_THRESHOLD
    }
    if (item.currency === 'USD') {
      return amount >= LOW_USD_THRESHOLD
    }
    return amount > 0
  })
}

export const getPrimaryCurrency = (
  snapshot: BalanceSnapshot | null,
  locale: Locale
): 'CNY' | 'USD' => {
  if (snapshot) {
    const primary = getDisplayBalances(snapshot.balanceInfos)[0]?.currency
    if (primary === 'CNY' || primary === 'USD') {
      return primary
    }
  }
  return locale === 'zh-CN' ? 'CNY' : 'USD'
}

export const formatBalanceValue = (amountStr: string, currency: string): string => {
  const amount = parseBalanceAmount(amountStr)
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(2)}`
}

export const formatBalanceCompact = (snapshot: BalanceSnapshot): string =>
  getDisplayBalances(snapshot.balanceInfos)
    .map((item) => formatBalanceValue(item.total_balance, item.currency))
    .join(' · ')
