import { create } from 'zustand'

const SHOW_USAGE_IN_CHAT_KEY = 'elsewhere:show-usage-in-chat'
const TITLE_MODEL_KEY = 'elsewhere:title-model'

const initialShowUsageInChat = (): boolean => {
  try {
    return localStorage.getItem(SHOW_USAGE_IN_CHAT_KEY) !== 'false'
  } catch {
    return true
  }
}

const initialTitleModel = (): string => {
  try {
    return localStorage.getItem(TITLE_MODEL_KEY)?.trim() ?? ''
  } catch {
    return ''
  }
}

type ElsewherePrefsState = {
  showUsageInChat: boolean
  titleModel: string
}

export const useElsewherePrefs = create<ElsewherePrefsState>(() => ({
  showUsageInChat: initialShowUsageInChat(),
  titleModel: initialTitleModel(),
}))

export const setShowUsageInChat = (showUsageInChat: boolean) => {
  try {
    localStorage.setItem(SHOW_USAGE_IN_CHAT_KEY, String(showUsageInChat))
  } catch {
    // 隐私模式或存储受限时仍更新内存态
  }
  useElsewherePrefs.setState({ showUsageInChat })
}

export const setTitleModel = (model: string) => {
  const titleModel = model.trim()
  try {
    if (titleModel) {
      localStorage.setItem(TITLE_MODEL_KEY, titleModel)
    } else {
      localStorage.removeItem(TITLE_MODEL_KEY)
    }
  } catch {
    // 隐私模式或存储受限时仍更新内存态
  }
  useElsewherePrefs.setState({ titleModel })
}
