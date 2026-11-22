import { create } from 'zustand'
import type { ClientToolCallBlock } from './types.js'

type ToolDetailState = {
  block: ClientToolCallBlock | null
}

export const useToolDetail = create<ToolDetailState>(() => ({ block: null }))

export const openToolDetail = (block: ClientToolCallBlock) =>
  useToolDetail.setState({ block })

export const closeToolDetail = () => useToolDetail.setState({ block: null })
