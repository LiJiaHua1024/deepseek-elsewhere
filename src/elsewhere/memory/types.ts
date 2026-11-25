export type MemoryNote = {
  /** 规范化后的相对路径，如 "MEMORY.md"、"subjects/physics.md" */
  path: string
  /** 原始 Markdown 文本（UTF-8，换行统一为 \n） */
  content: string
  /** 本地最后修改时间戳（ms） */
  updatedAt: number
  /** 最近一次与远端同步成功时的 Git blob SHA（仅 GitHub 模式） */
  remoteSha?: string
  /** 最近一次与远端同步成功时的基准文本，用于三路冲突判断 */
  baseContent?: string
}

export type DeletedMemoryPath = {
  path: string
  remoteSha?: string
  deletedAt: number
}

export type MemoryDreamProposal = {
  file: string
  action: 'add' | 'update' | 'remove'
  section?: string
  oldText?: string
  newText?: string
  reason: string
}

export type MemoryDreamRun = {
  appliedAt: number
  sessionCount: number
  items: MemoryDreamProposal[]
}

export type MemoryConfig = {
  enabled: boolean
  syncMode: 'local' | 'github'
  githubRepo: string
  githubBranch: string
  lastSyncedAt: number | null
  lastSyncCommitSha: string | null
  lastSyncStatus: 'idle' | 'synced' | 'pending' | 'conflict' | 'error'
  lastSyncError?: string
}

export type MemorySyncResult = {
  status: 'synced' | 'pending' | 'conflict' | 'error' | 'idle'
  pushed: number
  pulled: number
  conflicts: string[]
  commitSha?: string
  error?: string
}

export type MemoryWriteMode = 'append' | 'replace' | 'delete_line' | 'create'

export type MemoryWriteResult = {
  path: string
  changed: boolean
  message: string
  diffText: string
}
