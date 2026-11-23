export type SystemPromptPreset = {
  id: string
  name: string
  content: string
  builtin?: boolean
  createdAt: number
  updatedAt: number
}

export type SessionPromptOverride =
  | { mode: 'follow' }
  | { mode: 'none' }
  | { mode: 'preset'; presetId: string }
