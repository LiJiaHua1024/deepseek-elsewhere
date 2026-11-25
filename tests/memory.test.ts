import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { zipSync } from 'fflate'
import {
  exportMemoryArchive,
  parseMemoryArchiveBytes,
  planMemoryArchiveMerge,
} from '../src/elsewhere/memory/archive.js'
import { parseDreamProposals, validateDreamProposals } from '../src/elsewhere/memory/dreaming.js'
import {
  decodeBase64Utf8,
  encodeBase64Utf8,
  parseGithubRepo,
  planMemorySynchronization,
} from '../src/elsewhere/memory/github.js'
import { mutateMemoryContent } from '../src/elsewhere/memory/repositoryOps.js'
import {
  extractWikiLinks,
  normalizeMemoryPath,
  parseSourceMeta,
  resolveWikiTarget,
} from '../src/elsewhere/memory/store.js'
import type { MemoryNote } from '../src/elsewhere/memory/types.js'

const note = (path: string, content: string, extra: Partial<MemoryNote> = {}): MemoryNote => ({
  path,
  content,
  updatedAt: 1000,
  ...extra,
})

describe('memory paths and markdown helpers', () => {
  it('normalizes Markdown paths and protects MEMORY.md', () => {
    assert.equal(normalizeMemoryPath('memory'), 'MEMORY.md')
    assert.equal(normalizeMemoryPath('MEMORY.MD'), 'MEMORY.md')
    assert.equal(normalizeMemoryPath('subjects/physics'), 'subjects/physics.md')
    assert.equal(normalizeMemoryPath('./tech.md'), 'tech.md')
    assert.equal(normalizeMemoryPath('../secret.md'), null)
    assert.equal(normalizeMemoryPath('/absolute.md'), 'absolute.md')
    assert.equal(normalizeMemoryPath('C:/absolute.md'), null)
    assert.equal(normalizeMemoryPath('.git/config'), null)
    assert.equal(normalizeMemoryPath('a/b/c/d/e.md'), null)
  })

  it('parses source metadata and wikilinks only when present', () => {
    assert.deepEqual(
      parseSourceMeta('- 使用 uv [source: elsewhere; added: 2026-11-23]'),
      { text: '- 使用 uv', source: 'elsewhere', added: '2026-11-23' }
    )
    assert.deepEqual(extractWikiLinks('见 [[tech]] 和 [[subjects/physics|物理]]，没有链接的文本'), [
      'tech.md',
      'subjects/physics.md',
    ])
    assert.deepEqual(extractWikiLinks('普通 [链接] 文本'), [])
    assert.equal(resolveWikiTarget('tech|技术'), 'tech.md')
  })
})

describe('memory write operations', () => {
  it('appends one sourced bullet and deduplicates exact facts', () => {
    const first = mutateMemoryContent({
      path: 'preferences.md',
      mode: 'append',
      content: '# Preferences\n',
      text: 'Python 项目统一用 uv',
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    assert.match(first.nextContent, /- Python 项目统一用 uv \[source: elsewhere; added: \d{4}-\d{2}-\d{2}\]/)
    const second = mutateMemoryContent({
      path: 'preferences.md',
      mode: 'append',
      content: first.nextContent,
      text: 'Python 项目统一用 uv',
    })
    assert.equal(second.ok, true)
    if (second.ok) {
      assert.equal(second.result.changed, false)
      assert.equal(second.nextContent, first.nextContent)
    }
  })

  it('requires exact matches for replace/delete and never overwrites on failure', () => {
    const content = '# Tech\n\n- 旧版本 v0.1.0 [source: elsewhere; added: 2026-11-01]\n'
    const failed = mutateMemoryContent({
      path: 'tech.md',
      mode: 'replace',
      content,
      oldText: '不存在的原文',
      newText: '新内容',
    })
    assert.equal(failed.ok, false)

    const replaced = mutateMemoryContent({
      path: 'tech.md',
      mode: 'replace',
      content,
      oldText: '旧版本 v0.1.0',
      newText: '新版本 v0.3.0',
    })
    assert.equal(replaced.ok, true)
    if (replaced.ok) {
      assert.match(replaced.nextContent, /新版本 v0\.3\.0/)
    }

    const deleted = mutateMemoryContent({
      path: 'tech.md',
      mode: 'delete_line',
      content,
      text: '- 旧版本 v0.1.0 [source: elsewhere; added: 2026-11-01]',
    })
    assert.equal(deleted.ok, true)
    if (deleted.ok) {
      assert.equal(deleted.nextContent.includes('旧版本'), false)
    }
  })

  it('create is collision-safe', () => {
    const created = mutateMemoryContent({
      path: 'new.md',
      mode: 'create',
      content: null,
      text: '# New\n',
    })
    assert.equal(created.ok, true)
    const collision = mutateMemoryContent({
      path: 'new.md',
      mode: 'create',
      content: '# Existing\n',
      text: '# New\n',
    })
    assert.equal(collision.ok, false)
  })
})

describe('dreaming proposal parsing and validation', () => {
  it('parses strict JSON and filters stale oldText proposals', () => {
    const raw = JSON.stringify([
      {
        file: 'preferences.md',
        action: 'update',
        oldText: '- 旧偏好',
        newText: '- 新偏好',
        reason: '偏好变化',
      },
      { file: 'missing.md', action: 'update', oldText: '不存在', newText: 'x', reason: 'stale' },
      { file: 'subjects/physics', action: 'add', newText: '- 圆周运动易错', reason: '稳定易错点' },
    ])
    const parsed = parseDreamProposals(raw)
    assert.equal(parsed.length, 3)
    const valid = validateDreamProposals(parsed, [
      note('preferences.md', '# Preferences\n\n- 旧偏好\n'),
    ])
    assert.equal(valid.some((item) => item.file === 'missing.md'), false)
    assert.equal(valid.some((item) => item.file === 'subjects/physics.md'), true)
    assert.equal(valid.some((item) => item.file === 'MEMORY.md'), true)
  })
})

describe('github memory sync planning', () => {
  it('round-trips Chinese UTF-8 through base64 and parses owner/repo', () => {
    const text = '中文记忆 🌙 memory'
    assert.equal(decodeBase64Utf8(encodeBase64Utf8(text)), text)
    assert.deepEqual(parseGithubRepo('owner/memory-repo'), { owner: 'owner', repo: 'memory-repo' })
    assert.equal(parseGithubRepo('not/a/valid/repo'), null)
  })

  it('plans pull-only, push-only, and conflict-preserving syncs', () => {
    const base = '- base\n'
    const pull = planMemorySynchronization({
      localNotes: [note('a.md', base, { baseContent: base, remoteSha: '1' })],
      remoteNotes: [{ path: 'a.md', content: '- remote\n', sha: '2' }],
    })
    assert.equal(pull.pulls.length, 1)
    assert.equal(pull.pushes.length, 0)

    const push = planMemorySynchronization({
      localNotes: [note('a.md', '- local\n', { baseContent: base, remoteSha: '1' })],
      remoteNotes: [{ path: 'a.md', content: base, sha: '2' }],
    })
    assert.equal(push.pushes.length, 1)
    assert.equal(push.pulls.length, 0)

    const conflict = planMemorySynchronization({
      localNotes: [note('a.md', '- local\n', { baseContent: base, remoteSha: '1' })],
      remoteNotes: [{ path: 'a.md', content: '- remote\n', sha: '2' }],
      now: 1700000000000,
    })
    assert.equal(conflict.conflicts.length, 1)
    assert.match(conflict.conflicts[0].path, /^a\.conflict-\d+\.md$/)
    assert.equal(conflict.pushes.length, 0)
    assert.equal(conflict.pulls.length, 0)
  })
})

describe('memory ZIP archives', () => {
  it('export/import round-trips losslessly', async () => {
    const notes = [
      note('MEMORY.md', '# Memory\n\n- [[tech]] 技术\n'),
      note('tech.md', '# Tech\n\n- 中文内容 [source: elsewhere; added: 2026-11-23]\n'),
    ]
    const blob = await exportMemoryArchive(notes)
    const parsed = parseMemoryArchiveBytes(new Uint8Array(await blob.arrayBuffer()))
    assert.deepEqual(parsed.entries, notes.map((item) => ({ path: item.path, content: item.content })))
    assert.deepEqual(parsed.ignored, [])
  })

  it('strips one top-level directory and ignores .git/non-Markdown entries', () => {
    const encoder = new TextEncoder()
    const bytes = zipSync({
      'memory/MEMORY.md': encoder.encode('# Memory\n'),
      'memory/.git/config': encoder.encode('secret'),
      'memory/readme.txt': encoder.encode('ignore'),
    })
    const parsed = parseMemoryArchiveBytes(bytes)
    assert.deepEqual(parsed.entries, [{ path: 'MEMORY.md', content: '# Memory\n' }])
    assert.equal(parsed.ignored.length, 2)
  })

  it('merge preserves both sides through conflict copies', () => {
    const plan = planMemoryArchiveMerge({
      existing: [note('tech.md', 'local')],
      imported: [
        { path: 'tech.md', content: 'remote' },
        { path: 'new.md', content: 'new' },
      ],
      now: 1700000000000,
    })
    assert.deepEqual(plan.writes, [{ path: 'new.md', content: 'new' }])
    assert.equal(plan.conflicts.length, 1)
    assert.equal(plan.conflicts[0].content, 'remote')
    assert.match(plan.conflicts[0].path, /^tech\.conflict-\d+\.md$/)
  })
})
