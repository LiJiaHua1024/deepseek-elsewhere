import { android, ensureAndroidPyodideFiles } from '../../app/android.js'
import { createId } from '../../utils/id.js'
import type { ToolExecutionResult } from '../tools/types.js'
import type { MountedPythonFile } from './attachments.js'
import {
  PYODIDE_CDN_BASE,
  PYTHON_MAX_IMAGES,
  PYTHON_MAX_OUTPUT_CHARS,
  PYTHON_TIMEOUT_MS,
} from './config.js'
import {
  extractPythonImports,
  resolvePackagePlanFromLock,
  type PyodideLockData,
} from './packages.js'
import { usePyodideRuntime } from './runtimeState.js'
import type { WorkerRunRequest, WorkerRunResponse } from './worker.js'

const MAX_IMAGE_DATA_URL_LENGTH = 2 * 1024 * 1024

let cachedLock: PyodideLockData | null = null
let activeWorker: Worker | null = null
let queue: Promise<void> = Promise.resolve()

const getIndexUrl = (): string => (android ? '/pyodide/' : PYODIDE_CDN_BASE)

const loadLockData = async (): Promise<PyodideLockData | null> => {
  if (cachedLock) {
    return cachedLock
  }
  try {
    const response = await fetch(`${getIndexUrl()}pyodide-lock.json`)
    if (!response.ok) {
      return null
    }
    const parsed = (await response.json()) as PyodideLockData
    cachedLock = parsed
    return parsed
  } catch {
    return null
  }
}

const createPythonWorker = (): Worker =>
  new Worker(
    new URL(/* webpackChunkName: "python-worker" */ './worker.ts', import.meta.url)
  )

export const terminatePythonWorker = () => {
  if (activeWorker) {
    activeWorker.terminate()
    activeWorker = null
  }
}

export const formatPythonExecutionResult = (raw: {
  stdout: string
  stderr: string
  result: string | null
  error: string | null
  images: string[]
}): ToolExecutionResult => {
  const parts: string[] = []
  if (raw.stdout) {
    parts.push(raw.stdout.replace(/\s+$/, ''))
  }
  if (!raw.error && raw.result !== null && raw.result !== '') {
    parts.push(raw.result)
  }
  if (raw.stderr) {
    parts.push(`[stderr]\n${raw.stderr.replace(/\s+$/, '')}`)
  }
  if (raw.error) {
    parts.push(raw.error.replace(/\s+$/, ''))
  }

  let text = parts.join('\n')
  const images = raw.images
    .slice(0, PYTHON_MAX_IMAGES)
    .map((b64) => `data:image/png;base64,${b64}`)
    .filter((url) => url.length <= MAX_IMAGE_DATA_URL_LENGTH)

  const totalChars = text.length
  const truncated = totalChars > PYTHON_MAX_OUTPUT_CHARS
  if (truncated) {
    text = `${text.slice(0, PYTHON_MAX_OUTPUT_CHARS)}\n\n[Truncated: showing first ${PYTHON_MAX_OUTPUT_CHARS} of ${totalChars} chars]`
  }

  if (images.length > 0) {
    const note = `Generated ${images.length} chart image(s) displayed to the user.`
    text = text ? `${text}\n\n${note}` : note
  } else if (!text) {
    text = '(No output)'
  }

  return {
    content: text,
    ...(raw.error ? { isError: true } : {}),
    meta: {
      kind: 'python',
      ...(images.length > 0 ? { images } : {}),
      ...(truncated ? { truncated: true } : {}),
    },
  }
}

const executeInWorker = ({
  code,
  packages,
  files,
  signal,
  timeoutMs = PYTHON_TIMEOUT_MS,
}: {
  code: string
  packages: string[]
  files: MountedPythonFile[]
  signal: AbortSignal
  timeoutMs?: number
}): Promise<WorkerRunResponse> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
      return
    }
    let worker = activeWorker
    if (!worker) {
      try {
        worker = createPythonWorker()
        activeWorker = worker
      } catch (error) {
        reject(error)
        return
      }
    }

    const runId = createId()
    let settled = false
    let timedOut = false

    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      worker.removeEventListener('message', onMessage)
      worker.removeEventListener('error', onError)
      worker.removeEventListener('messageerror', onMessageError)
    }

    const terminateAndFail = (err: unknown) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      if (activeWorker === worker) {
        activeWorker = null
      }
      worker.terminate()
      reject(err)
    }

    const onAbort = () => {
      terminateAndFail(
        signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
      )
    }

    const timer = setTimeout(() => {
      timedOut = true
      terminateAndFail(
        new Error(
          `Python execution timed out after ${Math.round(timeoutMs / 1000)} seconds.`
        )
      )
    }, timeoutMs)

    const onMessage = ({ data }: MessageEvent<WorkerRunResponse | { type: 'ready' }>) => {
      if (settled || !data || data.type !== 'result' || data.id !== runId) {
        return
      }
      settled = true
      cleanup()
      resolve(data)
    }

    const onError = (event: ErrorEvent) => {
      if (!timedOut) {
        terminateAndFail(new Error(event.message || 'Python worker error'))
      }
    }

    const onMessageError = () => {
      terminateAndFail(new Error('Python worker message deserialization failed'))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    worker.addEventListener('message', onMessage)
    worker.addEventListener('error', onError)
    worker.addEventListener('messageerror', onMessageError)

    const request: WorkerRunRequest = {
      type: 'run',
      id: runId,
      indexURL: getIndexUrl(),
      code,
      packages,
      files: files.map(({ name, data }) => ({ name, data })),
    }
    worker.postMessage(request)
  })

export const runPythonScript = async ({
  code,
  files = [],
  signal,
  timeoutMs = PYTHON_TIMEOUT_MS,
}: {
  code: string
  files?: MountedPythonFile[]
  signal: AbortSignal
  timeoutMs?: number
}): Promise<ToolExecutionResult> => {
  if (android && !usePyodideRuntime.getState().installed) {
    return {
      content: 'Python runtime is not downloaded yet. Please enable Python execution in Tools first.',
      isError: true,
    }
  }

  let packages: string[] = []
  const imported = extractPythonImports(code)
  if (imported.length > 0) {
    const lock = await loadLockData()
    const plan = resolvePackagePlanFromLock(lock, imported)
    packages = plan.packages
    if (android && plan.files.length > 0) {
      try {
        await ensureAndroidPyodideFiles(plan.files, signal)
      } catch (error) {
        if (signal.aborted) {
          throw error
        }
        return {
          content: `Failed to load required Python package(s): ${
            error instanceof Error ? error.message : String(error)
          }. Use Python standard library approaches when offline.`,
          isError: true,
        }
      }
    }
  }

  let output!: ToolExecutionResult
  const task = queue.then(async () => {
    signal.throwIfAborted()
    try {
      const response = await executeInWorker({ code, packages, files, signal, timeoutMs })
      output = formatPythonExecutionResult(response)
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      output = {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      }
    }
  })
  queue = task.catch(() => {})
  await task
  return output
}
