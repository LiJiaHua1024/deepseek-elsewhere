import { create } from 'zustand'

type StatusSheetState = {
  open: boolean
  sessionId: string | null
  expandSummary: boolean
}

export const useStatusSheet = create<StatusSheetState>(() => ({
  open: false,
  sessionId: null,
  expandSummary: false,
}))

export const openSessionStatus = (sessionId: string, expandSummary = false) => {
  useStatusSheet.setState({ open: true, sessionId, expandSummary })
}

export const closeSessionStatus = () => {
  useStatusSheet.setState({ open: false, expandSummary: false })
}
