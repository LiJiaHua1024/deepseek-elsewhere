import { collectPythonMountFiles, filterMountableAttachments } from '../python/attachments.js'
import { runPythonScript } from '../python/sandbox.js'
import type { ClientToolDefinition, ToolFileAttachment } from './types.js'

const BASE_PYTHON_DESCRIPTION =
  'Execute Python 3 code in an isolated local WebAssembly sandbox (no internet access, no host filesystem access). Use this for exact math, statistics, data processing, verifying code logic, analyzing user-attached text/CSV/JSON files mounted read-only under /mnt/files/, or plotting charts with matplotlib (call plt.show() to display figures to the user). Do not call this for trivial arithmetic or simple conceptual questions you can answer directly. Execution times out after 30 seconds and text output is truncated at 12,000 characters. If execution fails or a third-party package is unavailable, fix the code or fall back to standard library approaches rather than repeating the same failing code.'

export const createPythonTool = (
  currentAttachments: readonly ToolFileAttachment[] = []
): ClientToolDefinition => {
  const mountable = filterMountableAttachments(currentAttachments)
  const mountHint =
    mountable.length > 0
      ? `\nAttached files mounted read-only: ${mountable.map((file) => `/mnt/files/${file.mountName}`).join(', ')}`
      : ''

  return {
    name: 'run_python',
    description: `${BASE_PYTHON_DESCRIPTION}${mountHint}`,
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Python 3 source code to run.' },
      },
      required: ['code'],
    },
    source: 'builtin',
    readOnly: true,
    execute: async (input, ctx) => {
      const code = typeof input.code === 'string' ? input.code : ''
      if (!code.trim()) {
        return { content: 'Missing required parameter: code', isError: true }
      }
      const files = await collectPythonMountFiles(
        ctx.attachments ?? currentAttachments,
        ctx.loadFile,
        ctx.signal
      )
      return runPythonScript({ code, files, signal: ctx.signal })
    },
  }
}
