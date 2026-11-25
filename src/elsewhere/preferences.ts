import { create } from 'zustand'

const SHOW_USAGE_IN_CHAT_KEY = 'elsewhere:show-usage-in-chat'
const TITLE_MODEL_KEY = 'elsewhere:title-model'
const BACKGROUND_KEEP_ALIVE_KEY = 'elsewhere:background-keep-alive'
const BACKGROUND_NOTIFY_KEY = 'elsewhere:background-notify'
const NOTIFICATION_PERMISSION_ASKED_KEY = 'elsewhere:notification-permission-asked'
const SLICE_LONG_IMAGE_KEY = 'elsewhere:slice-long-image'
const CUSTOM_PDF_MODE_KEY = 'elsewhere:custom-pdf-mode'

const readBoolPref = (key: string, defaultValue: boolean): boolean => {
  try {
    const raw = localStorage.getItem(key)
    if (raw === 'true') {
      return true
    }
    if (raw === 'false') {
      return false
    }
    return defaultValue
  } catch {
    return defaultValue
  }
}

const writeBoolPref = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // 隐私模式或存储受限时仍更新内存态
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
  backgroundKeepAlive: boolean
  backgroundNotify: boolean
  notificationPermissionAsked: boolean
  sliceLongImage: boolean
  customPdfMode: 'auto' | 'local'
}

export const useElsewherePrefs = create<ElsewherePrefsState>(() => ({
  showUsageInChat: readBoolPref(SHOW_USAGE_IN_CHAT_KEY, true),
  titleModel: initialTitleModel(),
  backgroundKeepAlive: readBoolPref(BACKGROUND_KEEP_ALIVE_KEY, true),
  backgroundNotify: readBoolPref(BACKGROUND_NOTIFY_KEY, true),
  notificationPermissionAsked: readBoolPref(NOTIFICATION_PERMISSION_ASKED_KEY, false),
  sliceLongImage: readBoolPref(SLICE_LONG_IMAGE_KEY, true),
  customPdfMode: (() => {
    try {
      return localStorage.getItem(CUSTOM_PDF_MODE_KEY) === 'local' ? 'local' : 'auto'
    } catch {
      return 'auto'
    }
  })(),
}))

export const setShowUsageInChat = (showUsageInChat: boolean) => {
  writeBoolPref(SHOW_USAGE_IN_CHAT_KEY, showUsageInChat)
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

export const setBackgroundKeepAlive = (backgroundKeepAlive: boolean) => {
  writeBoolPref(BACKGROUND_KEEP_ALIVE_KEY, backgroundKeepAlive)
  useElsewherePrefs.setState({ backgroundKeepAlive })
}

export const setBackgroundNotify = (backgroundNotify: boolean) => {
  writeBoolPref(BACKGROUND_NOTIFY_KEY, backgroundNotify)
  useElsewherePrefs.setState({ backgroundNotify })
}

export const setNotificationPermissionAsked = (notificationPermissionAsked: boolean) => {
  writeBoolPref(NOTIFICATION_PERMISSION_ASKED_KEY, notificationPermissionAsked)
  useElsewherePrefs.setState({ notificationPermissionAsked })
}

export const setSliceLongImage = (sliceLongImage: boolean) => {
  writeBoolPref(SLICE_LONG_IMAGE_KEY, sliceLongImage)
  useElsewherePrefs.setState({ sliceLongImage })
}

export const setCustomPdfMode = (customPdfMode: 'auto' | 'local') => {
  try {
    localStorage.setItem(CUSTOM_PDF_MODE_KEY, customPdfMode)
  } catch {
    // 隐私模式或存储受限时仍更新内存态
  }
  useElsewherePrefs.setState({ customPdfMode })
}
