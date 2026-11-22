import { create } from 'zustand'

const SHOW_USAGE_IN_CHAT_KEY = 'elsewhere:show-usage-in-chat'

const initialShowUsageInChat = (): boolean => {
  try {
    return localStorage.getItem(SHOW_USAGE_IN_CHAT_KEY) !== 'false'
  } catch {
    return true
  }
}

type ElsewherePrefsState = {
  showUsageInChat: boolean
}

export const useElsewherePrefs = create<ElsewherePrefsState>(() => ({
  showUsageInChat: initialShowUsageInChat(),
}))

export const setShowUsageInChat = (showUsageInChat: boolean) => {
  try {
    localStorage.setItem(SHOW_USAGE_IN_CHAT_KEY, String(showUsageInChat))
  } catch {
    // 隐私模式或存储受限时仍更新内存态
  }
  useElsewherePrefs.setState({ showUsageInChat })
}
