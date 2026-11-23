export type PyodideLockPackage = {
  name?: string
  file_name?: string
  depends?: string[]
  imports?: string[]
}

export type PyodideLockData = {
  packages?: Record<string, PyodideLockPackage>
}

export type PackagePlan = {
  packages: string[]
  files: string[]
}

const stripPythonNoise = (code: string): string =>
  code
    .replace(/#[^\n]*/g, '')
    .replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, ' ')

export const extractPythonImports = (code: string): string[] => {
  const cleaned = stripPythonNoise(code)
  const modules = new Set<string>()

  const importPattern = /(?:^|[;\n])\s*import\s+([^\n;#]+)/g
  let match: RegExpExecArray | null = importPattern.exec(cleaned)
  while (match !== null) {
    const clause = match[1]
    for (const part of clause.split(',')) {
      const target = part.trim().split(/\s+as\s+/i)[0]?.trim()
      const root = target?.split('.')[0]?.trim()
      if (root && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(root)) {
        modules.add(root)
      }
    }
    match = importPattern.exec(cleaned)
  }

  const fromPattern = /(?:^|[;\n])\s*from\s+([a-zA-Z_][a-zA-Z0-9_.]*)\s+import\b/g
  match = fromPattern.exec(cleaned)
  while (match !== null) {
    const root = match[1].split('.')[0]?.trim()
    if (root && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(root)) {
      modules.add(root)
    }
    match = fromPattern.exec(cleaned)
  }

  return Array.from(modules)
}

export const resolvePackagePlanFromLock = (
  lock: PyodideLockData | null | undefined,
  importedModules: readonly string[]
): PackagePlan => {
  const packagesMap = lock?.packages
  if (!packagesMap || importedModules.length === 0) {
    return { packages: [], files: [] }
  }

  const importIndex = new Map<string, string>()
  for (const [pkgKey, meta] of Object.entries(packagesMap)) {
    if (Array.isArray(meta.imports)) {
      for (const mod of meta.imports) {
        if (typeof mod === 'string' && mod && !importIndex.has(mod)) {
          importIndex.set(mod, pkgKey)
        }
      }
    }
  }

  const directRoots: string[] = []
  for (const mod of importedModules) {
    const mapped =
      importIndex.get(mod) ??
      (Object.hasOwn(packagesMap, mod) ? mod : undefined) ??
      (Object.hasOwn(packagesMap, mod.toLowerCase()) ? mod.toLowerCase() : undefined)
    if (mapped && !directRoots.includes(mapped)) {
      directRoots.push(mapped)
    }
  }

  if (directRoots.length === 0) {
    return { packages: [], files: [] }
  }

  const visited = new Set<string>()
  const queue = [...directRoots]
  const files: string[] = []

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current || visited.has(current)) {
      continue
    }
    visited.add(current)
    const meta = packagesMap[current]
    if (!meta) {
      continue
    }
    if (typeof meta.file_name === 'string' && meta.file_name && !files.includes(meta.file_name)) {
      files.push(meta.file_name)
    }
    if (Array.isArray(meta.depends)) {
      for (const dep of meta.depends) {
        if (typeof dep === 'string' && dep && !visited.has(dep) && Object.hasOwn(packagesMap, dep)) {
          queue.push(dep)
        }
      }
    }
  }

  return { packages: directRoots, files }
}
