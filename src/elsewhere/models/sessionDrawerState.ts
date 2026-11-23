import { create } from 'zustand'
import type { SessionPromptOverride } from '../prompts/types.js'
import type { ReasoningEffort, SamplingParams } from './types.js'

export type ModelDrawerTab = 'model' | 'prompt'

type ModelDrawerState = {
  open: boolean
  tab: ModelDrawerTab
}

export const useModelDrawer = create<ModelDrawerState>(() => ({
  open: false,
  tab: 'model',
}))

export const openModelDrawer = (tab: ModelDrawerTab = 'model') =>
  useModelDrawer.setState({ open: true, tab })

export const closeModelDrawer = () => useModelDrawer.setState({ open: false })

export const setModelDrawerTab = (tab: ModelDrawerTab) =>
  useModelDrawer.setState({ tab })

export type DraftSessionConfig = {
  promptOverride: SessionPromptOverride
  reasoningEffort: ReasoningEffort
  sampling: SamplingParams
}

const DEFAULT_DRAFT_CONFIG: DraftSessionConfig = {
  promptOverride: { mode: 'follow' },
  reasoningEffort: 'auto',
  sampling: {},
}

export const useDraftSessionConfig = create<DraftSessionConfig>(() => ({
  ...DEFAULT_DRAFT_CONFIG,
}))

export const setDraftPromptOverride = (promptOverride: SessionPromptOverride) =>
  useDraftSessionConfig.setState({ promptOverride })

export const setDraftReasoningEffort = (reasoningEffort: ReasoningEffort) =>
  useDraftSessionConfig.setState({ reasoningEffort })

export const setDraftSampling = (sampling: SamplingParams) =>
  useDraftSessionConfig.setState({ sampling })

export const resetDraftSessionConfig = () =>
  useDraftSessionConfig.setState({
    promptOverride: { mode: 'follow' },
    reasoningEffort: 'auto',
    sampling: {},
  })

export const consumeDraftSessionConfig = (): DraftSessionConfig => {
  const current = useDraftSessionConfig.getState()
  resetDraftSessionConfig()
  return current
}
