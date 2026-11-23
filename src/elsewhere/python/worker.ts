declare const importScripts: ((...urls: string[]) => void) | undefined

type PyodideFs = {
  mkdir: (path: string) => void
  stat: (path: string) => unknown
  readdir: (path: string) => string[]
  unlink: (path: string) => void
  rmdir: (path: string) => void
  writeFile: (path: string, data: Uint8Array) => void
  chmod?: (path: string, mode: number) => void
  isDir?: (mode: number) => boolean
}

type PyodideGlobalProxy = {
  get: (key: string) => unknown
  set: (key: string, value: unknown) => void
}

type PyodideResultProxy = {
  toJs?: (options?: { dict_converter?: typeof Object.fromEntries }) => unknown
  destroy?: () => void
}

type PyodideInstance = {
  FS: PyodideFs
  globals: PyodideGlobalProxy
  loadPackage: (names: string[]) => Promise<void>
  runPythonAsync: (code: string) => Promise<unknown>
}

export type WorkerRunRequest = {
  type: 'run'
  id: string
  indexURL: string
  code: string
  packages: string[]
  files: { name: string; data: Uint8Array }[]
}

export type WorkerRunResponse = {
  type: 'result'
  id: string
  stdout: string
  stderr: string
  result: string | null
  error: string | null
  images: string[]
}

const PYTHON_RUNNER = `
import ast
import base64
import contextlib
import io
import os
import sys
import traceback

os.environ['MPLBACKEND'] = 'Agg'

def __elsewhere_run(source, hook_mpl):
    out = io.StringIO()
    err = io.StringIO()
    images = []
    result_repr = None
    error_text = None

    if hook_mpl or 'matplotlib' in sys.modules:
        try:
            import matplotlib
            matplotlib.use('Agg')
            import matplotlib.pyplot as _plt
            _plt.close('all')
            def _capture():
                for _num in list(_plt.get_fignums()):
                    if len(images) >= 3:
                        break
                    _fig = _plt.figure(_num)
                    _buf = io.BytesIO()
                    _fig.savefig(_buf, format='png', dpi=140, bbox_inches='tight')
                    images.append(base64.b64encode(_buf.getvalue()).decode('ascii'))
                _plt.close('all')
            _plt.show = lambda *args, **kwargs: _capture()
        except Exception:
            pass

    ns = {'__name__': '__main__'}
    try:
        tree = ast.parse(source, filename='<script>', mode='exec')
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = ast.Expression(tree.body.pop().value)
            ast.fix_missing_locations(last_expr)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            if tree.body:
                exec(compile(tree, '<script>', 'exec'), ns)
            if last_expr is not None:
                val = eval(compile(last_expr, '<script>', 'eval'), ns)
                if val is not None:
                    result_repr = repr(val)
            if 'matplotlib.pyplot' in sys.modules:
                import matplotlib.pyplot as _plt_end
                for _num in list(_plt_end.get_fignums()):
                    if len(images) >= 3:
                        break
                    _fig = _plt_end.figure(_num)
                    _buf = io.BytesIO()
                    _fig.savefig(_buf, format='png', dpi=140, bbox_inches='tight')
                    images.append(base64.b64encode(_buf.getvalue()).decode('ascii'))
                _plt_end.close('all')
    except Exception:
        error_text = traceback.format_exc()

    return {
        'stdout': out.getvalue(),
        'stderr': err.getvalue(),
        'result': result_repr,
        'error': error_text,
        'images': images,
    }
`

let loadedUrl = ''
let pyodidePromise: Promise<PyodideInstance> | null = null
let runnerInstalled = false

const ensurePyodide = async (indexURL: string): Promise<PyodideInstance> => {
  if (pyodidePromise && loadedUrl === indexURL) {
    return pyodidePromise
  }
  loadedUrl = indexURL
  runnerInstalled = false
  pyodidePromise = (async () => {
    const scope = globalThis as unknown as {
      loadPyodide?: (options: { indexURL: string }) => Promise<PyodideInstance>
    }
    if (typeof scope.loadPyodide !== 'function') {
      if (typeof importScripts !== 'function') {
        throw new Error('Worker script loader unavailable')
      }
      importScripts(`${indexURL}pyodide.js`)
    }
    if (typeof scope.loadPyodide !== 'function') {
      throw new Error('Failed to load Python runtime')
    }
    return scope.loadPyodide({ indexURL })
  })()
  return pyodidePromise
}

const ensureDir = (fs: PyodideFs, dirPath: string) => {
  try {
    fs.stat(dirPath)
  } catch {
    fs.mkdir(dirPath)
  }
}

const resetMountDir = (fs: PyodideFs, files: { name: string; data: Uint8Array }[]) => {
  ensureDir(fs, '/mnt')
  ensureDir(fs, '/mnt/files')
  for (const entry of fs.readdir('/mnt/files')) {
    if (entry === '.' || entry === '..') {
      continue
    }
    try {
      fs.unlink(`/mnt/files/${entry}`)
    } catch {
      // Ignore cleanup errors for non-file entries
    }
  }
  for (const file of files) {
    const path = `/mnt/files/${file.name}`
    fs.writeFile(path, file.data)
    try {
      fs.chmod?.(path, 0o444)
    } catch {
      // Ignore if virtual FS omits chmod
    }
  }
}

const handleRun = async (req: WorkerRunRequest) => {
  try {
    const pyodide = await ensurePyodide(req.indexURL)
    if (!runnerInstalled) {
      await pyodide.runPythonAsync(PYTHON_RUNNER)
      runnerInstalled = true
    }
    if (req.packages.length > 0) {
      await pyodide.loadPackage(req.packages)
    }
    resetMountDir(pyodide.FS, req.files)
    pyodide.globals.set('__elsewhere_source', req.code)
    pyodide.globals.set('__elsewhere_hook_mpl', req.packages.includes('matplotlib'))
    const raw = (await pyodide.runPythonAsync(
      '__elsewhere_run(__elsewhere_source, __elsewhere_hook_mpl)'
    )) as PyodideResultProxy | Record<string, unknown>

    const proxy = raw as PyodideResultProxy
    const plain =
      raw && typeof proxy.toJs === 'function'
        ? (proxy.toJs({
            dict_converter: Object.fromEntries,
          }) as Record<string, unknown>)
        : (raw as Record<string, unknown>)
    if (raw && typeof proxy.destroy === 'function') {
      proxy.destroy()
    }

    const response: WorkerRunResponse = {
      type: 'result',
      id: req.id,
      stdout: typeof plain?.stdout === 'string' ? plain.stdout : '',
      stderr: typeof plain?.stderr === 'string' ? plain.stderr : '',
      result: typeof plain?.result === 'string' ? plain.result : null,
      error: typeof plain?.error === 'string' ? plain.error : null,
      images: Array.isArray(plain?.images)
        ? plain.images.filter((item): item is string => typeof item === 'string')
        : [],
    }
    globalThis.postMessage(response)
  } catch (error) {
    const response: WorkerRunResponse = {
      type: 'result',
      id: req.id,
      stdout: '',
      stderr: '',
      result: null,
      error: error instanceof Error ? error.message : String(error),
      images: [],
    }
    globalThis.postMessage(response)
  }
}

globalThis.addEventListener('message', ({ data }: MessageEvent<WorkerRunRequest>) => {
  if (data?.type === 'run') {
    void handleRun(data)
  }
})

globalThis.postMessage({ type: 'ready' })
