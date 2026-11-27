import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  filterMountableAttachments,
  isMountablePythonAttachment,
  sanitizeMountFilename,
} from '../src/elsewhere/python/attachments.js'
import { PYTHON_MAX_FILE_BYTES, PYTHON_MAX_OUTPUT_CHARS } from '../src/elsewhere/python/config.js'
import {
  extractPythonImports,
  resolvePackagePlanFromLock,
  type PyodideLockData,
} from '../src/elsewhere/python/packages.js'
import { formatPythonExecutionResult } from '../src/elsewhere/python/sandbox.js'
import {
  buildExpandedSnippet,
  createHistorySearchTool,
  HISTORY_MAX_OUTPUT_CHARS,
} from '../src/elsewhere/tools/historyTool.js'
import {
  formatLocalDateLine,
  formatReminderPrefix,
  isLocalDateReminder,
  prependReminderToUserContent,
} from '../src/elsewhere/tools/systemTime.js'
import type { SearchToolsRuntimeConfig, ToolExecutionContext } from '../src/elsewhere/tools/types.js'
import type { Session, SessionSummary } from '../src/services/chat/types.js'

const dummyConfig: SearchToolsRuntimeConfig = {
  engine: 'deepseek',
  officialApiKey: '',
  apiKeys: {},
  searxngUrl: '',
  webFetchMode: 'off',
  useExternalOnOfficial: false,
}

const dummyCtx: ToolExecutionContext = {
  signal: new AbortController().signal,
  config: dummyConfig,
}

describe('local daily date snapshot reminder', () => {
  it('formats date-only snapshot without clock minutes and folds into user content', () => {
    const morning = new Date(2026, 10, 23, 9, 5)
    const evening = new Date(2026, 10, 23, 22, 47)
    const lineMorning = formatLocalDateLine(morning)
    const lineEvening = formatLocalDateLine(evening)

    assert.match(lineMorning, /^Current local date: 2026-11-23 \(Monday, UTC[+-]\d{2}:\d{2}\)\.$/)
    assert.equal(lineMorning, lineEvening)
    assert.equal(isLocalDateReminder(lineMorning), true)
    assert.equal(isLocalDateReminder('2026-11-23,星期一,成都,Web,中文'), false)

    assert.equal(
      formatReminderPrefix('2026-11-23,星期一,成都,Web,中文'),
      '[Current local date: 2026-11-23 (星期一).]'
    )
    assert.equal(
      prependReminderToUserContent('今天天气如何', lineMorning),
      `[${lineMorning}]\n\n今天天气如何`
    )
    assert.deepEqual(
      prependReminderToUserContent(
        [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
          },
        ],
        lineMorning
      ),
      [
        { type: 'text', text: `[${lineMorning}]` },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'AA==' },
        },
      ]
    )
  })
})

describe('search_history builtin tool', () => {
  const makeSession = (id: string, title: string, text: string, updatedAt: number): Session => ({
    id,
    title,
    createdAt: updatedAt,
    updatedAt,
    messages: [
      { id: `${id}-u1`, role: 'user', content: text, files: [], createdAt: updatedAt },
      {
        id: `${id}-a1`,
        role: 'assistant',
        createdAt: updatedAt + 1,
        model: null,
        prefix: false,
        status: 'done',
        blocks: [{ type: 'text', text: `Reply about ${text}` }],
      },
    ],
  })

  it('excludes current session by default, expands snippets, clamps limits, and truncates over 6,000 chars', async () => {
    const current = makeSession('cur', 'Current Chat', 'quantum benchmark note', 5000)
    const past1 = makeSession(
      'old-1',
      'Architecture Review',
      `${'prefix '.repeat(25)}quantum latency targets in production${' suffix'.repeat(35)}`,
      4000
    )
    const longFiller = 'long '.repeat(400)
    const manySessions: Record<string, Session> = { cur: current, 'old-1': past1 }
    const summaries: SessionSummary[] = [current, past1]

    for (let i = 2; i <= 12; i += 1) {
      const s = makeSession(
        `s-${i}`,
        `Session ${i} ${'long-title-segment '.repeat(30)}`,
        `quantum finding ${i} ${longFiller}`,
        3000 - i * 10
      )
      manySessions[s.id] = s
      summaries.push({ id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt })
    }

    const tool = createHistorySearchTool({
      getHistoryState: () => ({
        activeSessionId: 'cur',
        summaries,
        sessionCache: manySessions,
      }),
    })

    const excludedRes = await tool.execute({ query: 'quantum', limit: 25 }, dummyCtx)
    assert.doesNotMatch(excludedRes.content, /"Current Chat"/)
    assert.match(excludedRes.content, /"Architecture Review"/)
    assert.ok(excludedRes.content.length <= HISTORY_MAX_OUTPUT_CHARS + 120)
    assert.equal(excludedRes.meta?.kind, 'history')
    assert.equal(excludedRes.meta?.kind === 'history' && excludedRes.meta.truncated, true)

    const includedRes = await tool.execute(
      { query: 'Current Chat', include_current: true, limit: 3 },
      dummyCtx
    )
    assert.match(includedRes.content, /"Current Chat"/)

    const expanded = buildExpandedSnippet(
      `${'word '.repeat(50)}important target keyword${' trailing'.repeat(60)}`,
      'target keyword'
    )
    assert.ok(expanded.includes('target keyword'))
    assert.ok(expanded.length >= 250 && expanded.length <= 360)
  })
})

describe('Python attachments, package resolution, and result formatting', () => {
  it('filters mountable text/tabular attachments and sanitizes colliding filenames', () => {
    assert.equal(
      isMountablePythonAttachment({ name: 'report.csv', size: 1024, isImage: false }),
      true
    )
    assert.equal(
      isMountablePythonAttachment({ name: 'photo.png', size: 1024, isImage: true }),
      false
    )
    assert.equal(
      isMountablePythonAttachment({
        name: 'huge.csv',
        size: PYTHON_MAX_FILE_BYTES + 1,
        isImage: false,
      }),
      false
    )
    assert.equal(
      isMountablePythonAttachment({ name: 'archive.pdf', size: 1024, isImage: false }),
      false
    )

    const used = new Set<string>()
    assert.equal(sanitizeMountFilename('../dir/销售 data.csv', used), '_data.csv')
    assert.equal(sanitizeMountFilename('dir1/data.csv', used), 'data.csv')
    assert.equal(sanitizeMountFilename('dir2/data.csv', used), 'data_1.csv')

    const mountable = filterMountableAttachments([
      { id: '1', name: 'notes.md', size: 100, isImage: false },
      { id: '2', name: 'pic.jpg', size: 100, isImage: true },
      { id: '3', name: 'notes.md', size: 120, isImage: false },
    ])
    assert.deepEqual(
      mountable.map((m) => m.mountName),
      ['notes.md', 'notes_1.md']
    )
  })

  it('extracts top-level imports ignoring comments/docstrings and resolves transitive lock dependencies', () => {
    const code = `
"""
import fake_doc
from ignored_doc import x
"""
# import fake_comment
import json, numpy as np
from matplotlib.pyplot import plot
import pandas as pd
`
    assert.deepEqual(
      extractPythonImports(code).sort(),
      ['json', 'matplotlib', 'numpy', 'pandas']
    )

    const lock: PyodideLockData = {
      packages: {
        numpy: { name: 'numpy', file_name: 'numpy-1.0.whl', depends: [], imports: ['numpy'] },
        matplotlib: {
          name: 'matplotlib',
          file_name: 'matplotlib-1.0.whl',
          depends: ['numpy', 'pillow'],
          imports: ['matplotlib', 'pylab'],
        },
        pillow: { name: 'pillow', file_name: 'pillow-1.0.whl', depends: [], imports: ['PIL'] },
        pandas: {
          name: 'pandas',
          file_name: 'pandas-1.0.whl',
          depends: ['numpy'],
          imports: ['pandas'],
        },
      },
    }

    const plan = resolvePackagePlanFromLock(lock, ['matplotlib', 'json'])
    assert.deepEqual(plan.packages, ['matplotlib'])
    assert.deepEqual(plan.files.sort(), ['matplotlib-1.0.whl', 'numpy-1.0.whl', 'pillow-1.0.whl'])
  })

  it('truncates long output cleanly and isolates up to 3 PNG images in meta without dumping base64 to text', () => {
    const formatted = formatPythonExecutionResult({
      stdout: 'A'.repeat(PYTHON_MAX_OUTPUT_CHARS + 300),
      stderr: '',
      result: '42',
      error: null,
      images: ['AA==', 'BB==', 'CC==', 'DD=='],
    })

    assert.equal(formatted.meta?.kind, 'python')
    assert.equal(formatted.meta?.kind === 'python' && formatted.meta.truncated, true)
    assert.deepEqual(
      formatted.meta?.kind === 'python' ? formatted.meta.images : [],
      [
        'data:image/png;base64,AA==',
        'data:image/png;base64,BB==',
        'data:image/png;base64,CC==',
      ]
    )
    assert.doesNotMatch(formatted.content, /data:image\/png/)
    assert.match(formatted.content, /\[Truncated: showing first 12000/)
    assert.match(formatted.content, /Generated 3 chart image\(s\) displayed to the user\./)
  })
})
