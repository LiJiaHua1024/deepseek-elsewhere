import { create } from 'zustand'

export type AttachmentProgressItem = {
  kind: 'slice' | 'pdf_text' | 'pdf_render'
  current?: number
  total?: number
}

type AttachmentProgressState = { sessions: Record<string, AttachmentProgressItem[]> }

export const useAttachmentProgress = create<AttachmentProgressState>(() => ({ sessions: {} }))

export const setAttachmentProgress = (
  sessionId: string,
  items: AttachmentProgressItem[] | null
) =>
  useAttachmentProgress.setState((state) => ({
    sessions: items?.length
      ? { ...state.sessions, [sessionId]: items }
      : Object.fromEntries(Object.entries(state.sessions).filter(([id]) => id !== sessionId)),
  }))
