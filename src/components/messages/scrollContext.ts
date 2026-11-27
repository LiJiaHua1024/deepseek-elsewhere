import { createContext, useContext } from 'react'

/** 用户上滑或展开思考内容时暂停跟随底部。 */
export const ScrollToBottomContext = createContext(() => {})

export const useStopFollowing = () => useContext(ScrollToBottomContext)

export const findScrollContainer = (element: HTMLElement | null): HTMLElement | null => {
  let cursor = element?.parentElement ?? null
  while (cursor) {
    const overflowY = getComputedStyle(cursor).overflowY
    if (overflowY === 'auto' || overflowY === 'scroll') {
      return cursor
    }
    cursor = cursor.parentElement
  }
  return null
}
