import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { saveAndroidHistory } from '../../app/android.js'
import { useChatStore } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { useIsZh } from '../text.js'
import { exportMemoryArchive, parseMemoryArchiveBytes, planMemoryArchiveMerge } from './archive.js'
import { applyDreamProposals, listUndreamedSessions, runDreaming } from './dreaming.js'
import type { DreamSessionCandidate } from './dreaming.js'
import { runMemoryGithubSync, testGithubConnection } from './github.js'
import { performHttpRequest } from '../search/http.js'
import {
  formatLocalDate,
  getMemorySecret,
  initMemoryStore,
  normalizeMemoryPath,
  parseSourceMeta,
  removeMemoryNote,
  replaceMemoryNotes,
  resolveWikiTarget,
  saveMemoryNote,
  setMemorySecret,
  sortedMemoryNotes,
  stripMarkdownExtension,
  updateMemoryConfig,
  upsertMemoryNote,
  useMemoryStore,
} from './store.js'
import type { MemoryDreamProposal, MemoryNote } from './types.js'
import styles from './MemorySettingsViews.module.css'

type Variant = 'web' | 'android'

type Status =
  | { kind: 'idle' }
  | { kind: 'busy'; message: string }
  | { kind: 'ok'; message: string }
  | { kind: 'error'; message: string }

const formatTime = (time: number, zh: boolean) =>
  new Intl.DateTimeFormat(zh ? 'zh-CN' : 'en-US', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(time)

const notePreview = (content: string) => {
  const line = content
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item && !item.startsWith('#'))
  return parseSourceMeta(line ?? '').text.replace(/^[-*]\s*/, '').slice(0, 90)
}

const downloadBlob = (name: string, blob: Blob) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const MemorySwitch = ({
  checked,
  onChange,
  disabled = false,
  label,
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={clsx(styles.switch, checked && styles.switchOn)}
    onClick={() => onChange(!checked)}
  >
    <span />
  </button>
)

const StatusText = ({ status }: { status: Status }) => {
  if (status.kind === 'idle') {
    return null
  }
  return (
    <div
      className={clsx(
        styles.statusText,
        status.kind === 'error' && styles.statusError,
        status.kind === 'ok' && styles.statusOk
      )}
    >
      {status.message}
    </div>
  )
}

export const MemoryHomeView = ({
  variant,
  onOpenNote,
  onCreateNote,
  onOpenDream,
  onOpenSync,
}: {
  variant: Variant
  onOpenNote: (path: string) => void
  onCreateNote: () => void
  onOpenDream: () => void
  onOpenSync: () => void
}) => {
  const zh = useIsZh()
  const ready = useMemoryStore((state) => state.ready)
  const enabled = useMemoryStore((state) => state.config.enabled)
  const syncMode = useMemoryStore((state) => state.config.syncMode)
  const lastSyncStatus = useMemoryStore((state) => state.config.lastSyncStatus)
  const notesRecord = useMemoryStore((state) => state.notes)
  const dreamedSessions = useMemoryStore((state) => state.dreamedSessions)
  const sessions = useChatStore((state) => state.sessions)
  const [query, setQuery] = useState('')
  const [pendingCount, setPendingCount] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    void initMemoryStore().then(() => {
      void listUndreamedSessions()
        .then((items) => {
          if (active) {
            setPendingCount(items.length)
          }
        })
        .catch(() => {
          if (active) {
            setPendingCount(null)
          }
        })
    })
    return () => {
      active = false
    }
  }, [dreamedSessions, sessions])

  const notes = useMemo(
    () => sortedMemoryNotes().filter((note) => Object.hasOwn(notesRecord, note.path)),
    [notesRecord]
  )
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? notes.filter(
        (note) =>
          note.path.toLowerCase().includes(normalizedQuery) ||
          note.content.toLowerCase().includes(normalizedQuery)
      )
    : notes

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.heroCard}>
        <div className={styles.heroText}>
          <div className={styles.heroTitle}>{zh ? '启用记忆' : 'Enable memory'}</div>
          <div className={styles.heroDesc}>
            {zh
              ? 'AI 可以在对话中按需读取和更新这些笔记；默认关闭。'
              : 'AI can read and update these notes when needed; off by default.'}
          </div>
        </div>
        <MemorySwitch
          checked={enabled}
          label={zh ? '启用记忆' : 'Enable memory'}
          onChange={(checked) => updateMemoryConfig({ enabled: checked })}
        />
      </div>

      <div className={styles.actionCard}>
        <button type="button" className={styles.actionRow} onClick={onOpenDream}>
          <span>{zh ? '整理记忆' : 'Organize memory'}</span>
          <span className={styles.actionMeta}>
            {pendingCount === null
              ? zh
                ? '检查中'
                : 'Checking'
              : pendingCount > 0
                ? zh
                  ? `${pendingCount} 个新对话`
                  : `${pendingCount} new chats`
                : zh
                  ? '已是最新'
                  : 'Up to date'}
            <span aria-hidden="true"> ›</span>
          </span>
        </button>
        <button type="button" className={styles.actionRow} onClick={onOpenSync}>
          <span>{zh ? '同步与备份' : 'Sync & backup'}</span>
          <span className={styles.actionMeta}>
            {syncMode === 'github'
              ? lastSyncStatus === 'conflict'
                ? zh
                  ? '有冲突'
                  : 'Conflicts'
                : zh
                  ? 'GitHub'
                  : 'GitHub'
              : zh
                ? '仅本地'
                : 'Local only'}
            <span aria-hidden="true"> ›</span>
          </span>
        </button>
      </div>

      <div className={styles.sectionHeader}>
        <span>{zh ? '记忆文件' : 'Memory notes'}</span>
        <button type="button" className={styles.smallPrimary} onClick={onCreateNote}>
          {zh ? '+ 新建' : '+ New'}
        </button>
      </div>
      <input
        type="search"
        className={styles.searchInput}
        value={query}
        placeholder={zh ? '搜索记忆' : 'Search memory'}
        onChange={(event) => setQuery(event.target.value)}
      />
      {!ready ? (
        <div className={styles.emptyCard}>{zh ? '正在读取…' : 'Loading…'}</div>
      ) : filtered.length === 0 ? (
        <div className={styles.emptyCard}>
          {zh ? '还没有匹配的记忆笔记' : 'No matching memory notes'}
        </div>
      ) : (
        <div className={styles.noteList}>
          {filtered.map((note) => (
            <button
              key={note.path}
              type="button"
              className={styles.noteCard}
              onClick={() => onOpenNote(note.path)}
            >
              <span className={styles.noteTop}>
                <span className={styles.noteName}>{stripMarkdownExtension(note.path)}</span>
                {note.path === 'MEMORY.md' ? (
                  <span className={styles.indexBadge}>{zh ? '主索引' : 'Index'}</span>
                ) : null}
              </span>
              <span className={styles.notePreview}>{notePreview(note.content) || '—'}</span>
              <span className={styles.noteTime}>{formatTime(note.updatedAt, zh)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const renderInlineMemoryText = ({
  text,
  notes,
  onOpenNote,
}: {
  text: string
  notes: Record<string, MemoryNote>
  onOpenNote: (path: string) => void
}) => {
  const parts: React.ReactNode[] = []
  const pattern = /\[\[([^\]\n]+)\]\]/g
  let cursor = 0
  let index = 0
  for (const match of text.matchAll(pattern)) {
    const position = match.index ?? 0
    if (position > cursor) {
      parts.push(text.slice(cursor, position))
    }
    const label = match[1]
    const target = resolveWikiTarget(label)
    const exists = target !== null && Object.hasOwn(notes, target)
    parts.push(
      <button
        key={`${position}-${index}`}
        type="button"
        className={clsx(styles.wikiLink, !exists && styles.wikiLinkMissing)}
        onClick={() => {
          if (target) {
            onOpenNote(target)
          }
        }}
      >
        [[{label}]]
      </button>
    )
    cursor = position + match[0].length
    index += 1
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return parts
}

const MemoryMarkdownPreview = ({
  content,
  notes,
  onOpenNote,
}: {
  content: string
  notes: Record<string, MemoryNote>
  onOpenNote: (path: string) => void
}) => {
  const lines = content.split('\n')
  return (
    <div className={styles.previewBox}>
      {lines.map((rawLine, index) => {
        const line = rawLine.trimEnd()
        if (!line.trim()) {
          return <div key={index} className={styles.previewGap} />
        }
        const heading = line.match(/^(#{1,4})\s+(.*)$/)
        if (heading) {
          return (
            <div key={index} className={styles.previewHeading}>
              {renderInlineMemoryText({ text: heading[2], notes, onOpenNote })}
            </div>
          )
        }
        const bullet = line.match(/^\s*[-*]\s+(.*)$/)
        const body = bullet?.[1] ?? line
        const meta = parseSourceMeta(body)
        return (
          <div key={index} className={clsx(styles.previewLine, bullet && styles.previewBullet)}>
            <span className={styles.previewText}>
              {renderInlineMemoryText({ text: meta.text, notes, onOpenNote })}
            </span>
            {meta.source ? (
              <span className={styles.sourceMeta}>
                {meta.source}
                {meta.added ? ` · ${meta.added}` : ''}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export const MemoryNoteEditorView = ({
  variant,
  path: initialPath,
  onBack,
  onOpenNote,
  onDeleted,
  onPathChange,
}: {
  variant: Variant
  path: string | null
  onBack: () => void
  onOpenNote: (path: string, sourcePath?: string) => void
  onDeleted: () => void
  onPathChange?: (path: string) => void
}) => {
  const zh = useIsZh()
  const notes = useMemoryStore((state) => state.notes)
  const normalizedInitial = initialPath ? normalizeMemoryPath(initialPath) : null
  const existing = normalizedInitial ? notes[normalizedInitial] : undefined
  const [path, setPath] = useState(normalizedInitial ?? '')
  const [content, setContent] = useState(
    existing?.content ?? (normalizedInitial ? '' : '# \n')
  )
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [deleting, setDeleting] = useState(false)
  const loadedPathRef = useRef<string | null>(null)
  const hadNoteRef = useRef(false)

  useEffect(() => {
    void initMemoryStore()
  }, [])

  useEffect(() => {
    if (!normalizedInitial) {
      if (loadedPathRef.current !== null) {
        setPath('')
        setContent('# \n')
      }
      loadedPathRef.current = null
      hadNoteRef.current = false
      return
    }
    const note = notes[normalizedInitial]
    if (loadedPathRef.current !== normalizedInitial || (!hadNoteRef.current && note)) {
      setPath(normalizedInitial)
      setContent(note?.content ?? '')
    }
    if (loadedPathRef.current !== normalizedInitial) {
      setStatus({ kind: 'idle' })
      setDeleting(false)
    }
    loadedPathRef.current = normalizedInitial
    hadNoteRef.current = Boolean(note)
  }, [normalizedInitial, notes])

  const isIndex = normalizeMemoryPath(path) === 'MEMORY.md'
  const normalized = normalizeMemoryPath(path)
  const persisted = normalized ? notes[normalized] : undefined
  const canSave = Boolean(normalized) && content.trim().length > 0

  const save = async () => {
    if (!normalized) {
      setStatus({ kind: 'error', message: zh ? '路径无效' : 'Invalid path' })
      return
    }
    setStatus({ kind: 'busy', message: zh ? '正在保存…' : 'Saving…' })
    const saved = await saveMemoryNote(normalized, content)
    if (!saved) {
      setStatus({ kind: 'error', message: zh ? '路径无效' : 'Invalid path' })
      return
    }
    setPath(saved.path)
    onPathChange?.(saved.path)
    setStatus({ kind: 'ok', message: zh ? '已保存' : 'Saved' })
  }

  const remove = async () => {
    if (!normalized || normalized === 'MEMORY.md') {
      return
    }
    setDeleting(true)
    const removed = await removeMemoryNote(normalized)
    setDeleting(false)
    if (removed) {
      onDeleted()
    } else {
      setStatus({ kind: 'error', message: zh ? '无法删除这篇笔记' : 'Unable to delete this note' })
    }
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      {variant === 'web' ? (
        <div className={styles.editorTopbar}>
          <button type="button" className={styles.backButton} onClick={onBack}>
            ‹ {zh ? '返回' : 'Back'}
          </button>
          <span className={styles.editorPathTitle}>{normalized ?? (zh ? '新建笔记' : 'New note')}</span>
        </div>
      ) : null}
      <div className={styles.editorCard}>
        <label className={styles.fieldLabel}>
          {zh ? '文件路径' : 'File path'}
          <input
            className={styles.input}
            value={path}
            placeholder="subjects/physics.md"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => setPath(event.target.value)}
          />
        </label>
        <textarea
          className={styles.editorArea}
          value={content}
          spellCheck={false}
          onChange={(event) => setContent(event.target.value)}
        />
        <div className={styles.editorActions}>
          {!isIndex && persisted ? (
            <button
              type="button"
              className={styles.dangerButton}
              disabled={deleting}
              onClick={() => void remove()}
            >
              {zh ? '删除此笔记' : 'Delete note'}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.primaryButton}
            disabled={!canSave || status.kind === 'busy'}
            onClick={() => void save()}
          >
            {status.kind === 'busy' ? (zh ? '保存中' : 'Saving') : zh ? '保存' : 'Save'}
          </button>
        </div>
        <StatusText status={status} />
      </div>
      <div className={styles.sectionHeader}>
        <span>{zh ? '预览' : 'Preview'}</span>
      </div>
      <MemoryMarkdownPreview
        content={content}
        notes={notes}
        onOpenNote={(target) => onOpenNote(target, normalized ?? normalizedInitial ?? undefined)}
      />
    </div>
  )
}

type DreamStage =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'loading' }
  | { kind: 'review'; candidates: DreamSessionCandidate[]; proposals: MemoryDreamProposal[] }
  | { kind: 'applied'; count: number }
  | { kind: 'error'; message: string }

const proposalKind = (
  proposal: MemoryDreamProposal,
  notes: Record<string, MemoryNote>
): 'new' | 'existing' | 'deleted' => {
  if (proposal.action === 'remove') {
    return 'deleted'
  }
  return Object.hasOwn(notes, proposal.file) ? 'existing' : 'new'
}

const ProposalDiff = ({ proposal, zh }: { proposal: MemoryDreamProposal; zh: boolean }) => (
  <div className={styles.diffBox}>
    {proposal.oldText ? <div className={styles.diffOld}>- {proposal.oldText}</div> : null}
    {proposal.newText ? (
      <div className={proposal.action === 'remove' ? styles.diffOld : styles.diffNew}>
        + {proposal.newText}
      </div>
    ) : null}
    {!proposal.oldText && !proposal.newText ? (
      <div className={styles.diffOld}>{zh ? '删除匹配内容' : 'Remove matched content'}</div>
    ) : null}
    <div className={styles.proposalReason}>{proposal.reason}</div>
  </div>
)

export const MemoryDreamView = ({ variant }: { variant: Variant }) => {
  const zh = useIsZh()
  const notes = useMemoryStore((state) => state.notes)
  const model = useSettings((state) => state.chatConfig.model || 'deepseek-flash')
  const [stage, setStage] = useState<DreamStage>({ kind: 'idle' })
  const [candidates, setCandidates] = useState<DreamSessionCandidate[]>([])
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [applying, setApplying] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const refreshCandidates = () => {
    void listUndreamedSessions()
      .then(setCandidates)
      .catch(() => setCandidates([]))
  }

  useEffect(() => {
    void initMemoryStore().then(refreshCandidates)
    return () => abortRef.current?.abort()
  }, [])

  const begin = () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setStage({ kind: 'loading' })
    void runDreaming({ signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) {
          return
        }
        setChecked(Object.fromEntries(result.proposals.map((_, index) => [index, true])))
        setStage({ kind: 'review', candidates: result.candidates, proposals: result.proposals })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setStage({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
  }

  const applySelected = async (
    review: Extract<DreamStage, { kind: 'review' }>
  ) => {
    const selected = review.proposals.filter((_, index) => checked[index])
    setApplying(true)
    try {
      const count = selected.length > 0 ? await applyDreamProposals(selected, review.candidates) : 0
      setStage({ kind: 'applied', count })
      refreshCandidates()
    } catch (error) {
      setStage({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setApplying(false)
    }
  }

  const groups = (proposals: MemoryDreamProposal[]) => {
    const order: Array<{ kind: 'new' | 'existing' | 'deleted'; label: string }> = [
      { kind: 'new', label: zh ? '新增笔记' : 'New notes' },
      { kind: 'existing', label: zh ? '更新现有笔记' : 'Existing notes' },
      { kind: 'deleted', label: zh ? '删除内容' : 'Removed content' },
    ]
    return order
      .map((group) => ({
        ...group,
        items: proposals
          .map((proposal, index) => ({ proposal, index }))
          .filter(({ proposal }) => proposalKind(proposal, notes) === group.kind),
      }))
      .filter((group) => group.items.length > 0)
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.modelHint}>
        {zh ? '使用当前聊天模型' : 'Using current chat model'} · {model}
      </div>
      {stage.kind === 'idle' || stage.kind === 'confirm' ? (
        <div className={styles.cardPadded}>
          <div className={styles.cardTitle}>
            {candidates.length > 0
              ? zh
                ? `有 ${candidates.length} 个新对话待整理`
                : `${candidates.length} new chats to review`
              : zh
                ? '没有待整理的新对话'
                : 'No new chats to organize'}
          </div>
          <p className={styles.cardDesc}>
            {zh
              ? '将回顾近期对话，提炼长期记忆、合并重复项并清理过时条目；结果会在写入前供你审核。'
              : 'Recent chats will be reviewed for durable memory, duplicates, and outdated items. You review everything before it is written.'}
          </p>
          {stage.kind === 'confirm' ? (
            <div className={styles.confirmBox}>
              <div>
                {zh
                  ? `将使用当前模型 ${model} 和对应 API 额度生成整理建议。继续吗？`
                  : `Use the current model ${model} and its API quota to generate proposals?`}
              </div>
              <div className={styles.confirmActions}>
                <button type="button" className={styles.secondaryButton} onClick={() => setStage({ kind: 'idle' })}>
                  {zh ? '取消' : 'Cancel'}
                </button>
                <button type="button" className={styles.primaryButton} onClick={begin}>
                  {zh ? '继续' : 'Continue'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className={styles.primaryButtonWide}
              disabled={candidates.length === 0}
              onClick={() => setStage({ kind: 'confirm' })}
            >
              {zh ? '开始整理' : 'Start organizing'}
            </button>
          )}
        </div>
      ) : null}

      {stage.kind === 'loading' ? (
        <div className={styles.emptyCard}>{zh ? '正在生成整理建议…' : 'Generating proposals…'}</div>
      ) : null}
      {stage.kind === 'error' ? (
        <div className={styles.cardPadded}>
          <div className={styles.statusError}>{stage.message}</div>
          <button type="button" className={styles.secondaryButton} onClick={() => setStage({ kind: 'idle' })}>
            {zh ? '返回' : 'Back'}
          </button>
        </div>
      ) : null}
      {stage.kind === 'applied' ? (
        <div className={clsx(styles.cardPadded, styles.completionCard)}>
          <div className={styles.completionStatus}>
            {zh ? `已应用 ${stage.count} 处记忆更新` : `Applied ${stage.count} memory updates`}
          </div>
          <button type="button" className={styles.secondaryButton} onClick={() => setStage({ kind: 'idle' })}>
            {zh ? '完成' : 'Done'}
          </button>
        </div>
      ) : null}

      {stage.kind === 'review' ? (
        <>
          <div className={styles.reviewHeader}>
            <span>
              {zh
                ? `回顾 ${stage.candidates.length} 个对话 · 建议 ${stage.proposals.length} 处更新`
                : `Reviewed ${stage.candidates.length} chats · ${stage.proposals.length} proposals`}
            </span>
            <button type="button" className={styles.linkButton} onClick={() => setStage({ kind: 'confirm' })}>
              {zh ? '重新整理' : 'Retry'}
            </button>
          </div>
          {stage.proposals.length === 0 ? (
            <div className={styles.emptyCard}>
              {zh ? '没有需要写入的长期记忆' : 'No durable memory changes proposed'}
            </div>
          ) : (
            groups(stage.proposals).map((group) => (
              <div key={group.kind} className={styles.proposalGroup}>
                <div className={styles.groupLabel}>{group.label}</div>
                {group.items.map(({ proposal, index }) => {
                  const selected = checked[index] !== false
                  return (
                    <button
                      key={`${proposal.file}-${index}`}
                      type="button"
                      className={clsx(styles.proposalCard, !selected && styles.proposalOff)}
       
                      onClick={() => setChecked((current) => ({ ...current, [index]: !selected }))}
                    >
                      <span className={styles.proposalTop}>
                        <span className={styles.proposalFile}>{proposal.file}</span>
                        <span className={clsx(styles.checkbox, selected && styles.checkboxOn)}>✓</span>
                      </span>
                      <ProposalDiff proposal={proposal} zh={zh} />
                    </button>
                  )
                })}
              </div>
            ))
          )}
          <div className={styles.bottomActions}>
            <button type="button" className={styles.secondaryButton} onClick={() => setStage({ kind: 'idle' })}>
              {zh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={applying || stage.proposals.length === 0}
              onClick={() => void applySelected(stage)}
            >
              {applying
                ? zh
                  ? '应用中'
                  : 'Applying'
                : zh
                  ? `应用（${stage.proposals.filter((_, index) => checked[index]).length}）`
                  : `Apply (${stage.proposals.filter((_, index) => checked[index]).length})`}
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

export const MemorySyncView = ({ variant }: { variant: Variant }) => {
  const zh = useIsZh()
  const config = useMemoryStore((state) => state.config)
  const notes = useMemoryStore((state) => state.notes)
  const [token, setToken] = useState(() => getMemorySecret())
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [importMode, setImportMode] = useState<'merge' | 'replace'>('merge')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    void initMemoryStore()
  }, [])

  const persistToken = (value: string) => {
    setToken(value)
    setMemorySecret(value)
  }

  const runTest = async () => {
    setStatus({ kind: 'busy', message: zh ? '正在测试连接…' : 'Testing connection…' })
    try {
      const name = await testGithubConnection(performHttpRequest, {
        repo: config.githubRepo,
        branch: config.githubBranch,
        token,
      })
      setStatus({ kind: 'ok', message: zh ? `连接正常：${name}` : `Connected: ${name}` })
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const runSync = async () => {
    setStatus({ kind: 'busy', message: zh ? '正在同步…' : 'Syncing…' })
    try {
      const result = await runMemoryGithubSync({ transport: performHttpRequest })
      const parts = [
        zh ? `上传 ${result.pushed}` : `${result.pushed} pushed`,
        zh ? `拉取 ${result.pulled}` : `${result.pulled} pulled`,
      ]
      if (result.conflicts.length > 0) {
        parts.push(zh ? `${result.conflicts.length} 个冲突副本` : `${result.conflicts.length} conflict copies`)
      }
      setStatus({
        kind: result.conflicts.length > 0 ? 'error' : 'ok',
        message: parts.join(' · '),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      updateMemoryConfig({ lastSyncStatus: 'error', lastSyncError: message })
      setStatus({ kind: 'error', message })
    }
  }

  const exportNotes = async () => {
    setStatus({ kind: 'busy', message: zh ? '正在导出…' : 'Exporting…' })
    try {
      const blob = await exportMemoryArchive(sortedMemoryNotes())
      const name = `elsewhere-memory-${formatLocalDate()}.zip`
      const saved = saveAndroidHistory ? await saveAndroidHistory(name, blob) : false
      if (!saved) {
        downloadBlob(name, blob)
      }
      setStatus({ kind: 'ok', message: zh ? '已导出记忆压缩包' : 'Memory archive exported' })
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const importNotes = async (file: File) => {
    setStatus({ kind: 'busy', message: zh ? '正在导入…' : 'Importing…' })
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const parsed = parseMemoryArchiveBytes(bytes)
      const now = Date.now()
      if (importMode === 'replace') {
        await replaceMemoryNotes(
          parsed.entries.map((entry) => ({ path: entry.path, content: entry.content, updatedAt: now }))
        )
      } else {
        const plan = planMemoryArchiveMerge({ existing: Object.values(notes), imported: parsed.entries, now })
        for (const entry of [...plan.writes, ...plan.conflicts]) {
          await upsertMemoryNote({ path: entry.path, content: entry.content, updatedAt: now })
        }
      }
      setStatus({
        kind: 'ok',
        message: zh
          ? `已导入 ${parsed.entries.length} 篇笔记${parsed.ignored.length ? `，忽略 ${parsed.ignored.length} 个文件` : ''}`
          : `Imported ${parsed.entries.length} notes${parsed.ignored.length ? `, ignored ${parsed.ignored.length} files` : ''}`,
      })
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div className={clsx(styles.container, variant === 'android' && styles.androidContainer)}>
      <div className={styles.cardPadded}>
        <div className={styles.cardTitle}>{zh ? '同步方式' : 'Sync method'}</div>
        <div className={clsx(styles.segmentedSmall, styles.syncModeControls)}>
          {(['local', 'github'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className={clsx(styles.segmentButton, config.syncMode === mode && styles.segmentButtonOn)}
              onClick={() => updateMemoryConfig({ syncMode: mode })}
            >
              {mode === 'local' ? (zh ? '仅本地' : 'Local only') : 'GitHub'}
            </button>
          ))}
        </div>
        {config.syncMode === 'github' ? (
          <div className={styles.githubForm}>
            <label className={styles.fieldLabel}>
              {zh ? '仓库' : 'Repository'}
              <input
                className={styles.input}
                value={config.githubRepo}
                placeholder="owner/memory-repo"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => updateMemoryConfig({ githubRepo: event.target.value })}
              />
            </label>
            <label className={styles.fieldLabel}>
              {zh ? '分支' : 'Branch'}
              <input
                className={styles.input}
                value={config.githubBranch}
                placeholder="main"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) =>
                  updateMemoryConfig({ githubBranch: event.target.value || 'main' })
                }
              />
            </label>
            <label className={styles.fieldLabel}>
              Personal Access Token
              <input
                className={styles.input}
                type="password"
                value={token}
                placeholder="github_pat_…"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                onChange={(event) => persistToken(event.target.value)}
              />
            </label>
            <div className={styles.bottomActions}>
              <button
                type="button"
                className={styles.secondaryButton}
                disabled={status.kind === 'busy'}
                onClick={() => void runTest()}
              >
                {zh ? '测试连接' : 'Test connection'}
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                disabled={status.kind === 'busy'}
                onClick={() => void runSync()}
              >
                {zh ? '立即同步' : 'Sync now'}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className={styles.cardPadded}>
        <div className={styles.cardTitle}>{zh ? '压缩包备份' : 'ZIP backup'}</div>
        <div className={styles.zipModeSection}>
          <div className={styles.zipModeLabel}>{zh ? '导入方式' : 'Import mode'}</div>
          <div className={styles.segmentedSmall}>
            {(['merge', 'replace'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={clsx(styles.segmentButton, importMode === mode && styles.segmentButtonOn)}
                onClick={() => setImportMode(mode)}
              >
                {mode === 'merge' ? (zh ? '合并导入' : 'Merge import') : zh ? '替换导入' : 'Replace import'}
              </button>
            ))}
          </div>
        </div>
        <div className={styles.zipActions}>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => fileInputRef.current?.click()}
          >
            {zh ? '导入记忆压缩包' : 'Import memory ZIP'}
          </button>
          <button type="button" className={styles.primaryButton} onClick={() => void exportNotes()}>
            {zh ? '导出记忆压缩包' : 'Export memory ZIP'}
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".zip,application/zip"
          className={styles.hiddenInput}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void importNotes(file)
            }
          }}
        />
      </div>
      <StatusText status={status} />
    </div>
  )
}

export const MemorySettings = () => {
  const [view, setView] = useState<'home' | 'note' | 'dream' | 'sync'>('home')
  const [notePath, setNotePath] = useState<string | null>(null)
  const [noteBackStack, setNoteBackStack] = useState<string[]>([])

  const openNote = (path: string, sourcePath?: string) => {
    const currentPath = sourcePath ?? (view === 'note' ? notePath : null)
    if (currentPath && currentPath !== path) {
      setNoteBackStack((current) => [...current, currentPath])
    }
    setNotePath(path)
    setView('note')
  }

  const backFromNote = () => {
    const previous = noteBackStack[noteBackStack.length - 1]
    if (previous) {
      setNoteBackStack((current) => current.slice(0, -1))
      setNotePath(previous)
      return
    }
    setView('home')
  }

  if (view === 'note') {
    return (
      <MemoryNoteEditorView
        variant="web"
        path={notePath}
        onBack={backFromNote}
        onOpenNote={openNote}
        onDeleted={() => setView('home')}
        onPathChange={setNotePath}
      />
    )
  }
  if (view === 'dream') {
    return <MemoryDreamView variant="web" />
  }
  if (view === 'sync') {
    return <MemorySyncView variant="web" />
  }
  return (
    <MemoryHomeView
      variant="web"
      onOpenNote={(path) => {
        setNoteBackStack([])
        openNote(path)
      }}
      onCreateNote={() => {
        setNoteBackStack([])
        setNotePath(null)
        setView('note')
      }}
      onOpenDream={() => setView('dream')}
      onOpenSync={() => setView('sync')}
    />
  )
}
