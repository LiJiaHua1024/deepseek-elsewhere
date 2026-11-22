import type { ClientToolDefinition } from './types.js'

const normalizeForJson = (value: unknown, seen: WeakSet<object>): unknown => {
  if (value === null || typeof value !== 'object') {
    return value
  }
  if (seen.has(value)) {
    return '[Circular]'
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return value.map((item) => (item === undefined ? null : normalizeForJson(item, seen)))
  }
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    const entry = source[key]
    if (entry !== undefined && typeof entry !== 'function' && typeof entry !== 'symbol') {
      sorted[key] = normalizeForJson(entry, seen)
    }
  }
  return sorted
}

/** 生成键顺序稳定的规范 JSON 字符串，用于比较工具调用签名。 */
export const canonicalStableJson = (value: unknown): string => {
  const normalized = normalizeForJson(value, new WeakSet())
  const serialized = JSON.stringify(normalized)
  return serialized ?? 'null'
}

export type BeforeToolExecuteHook = (call: {
  id: string
  name: string
  tool: ClientToolDefinition
  input: Record<string, unknown>
}) => Promise<'allow' | 'deny'>

export type ClientToolSchema = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type ToolRegistry = {
  register: (tool: ClientToolDefinition) => void
  get: (name: string) => ClientToolDefinition | undefined
  list: () => ClientToolDefinition[]
  toSchemas: () => ClientToolSchema[]
}

export const createToolRegistry = (
  initialTools: readonly ClientToolDefinition[] = []
): ToolRegistry => {
  const tools = new Map<string, ClientToolDefinition>()
  for (const tool of initialTools) {
    tools.set(tool.name, tool)
  }
  return {
    register: (tool) => {
      tools.set(tool.name, tool)
    },
    get: (name) => tools.get(name),
    list: () => Array.from(tools.values()),
    toSchemas: () =>
      Array.from(tools.values()).map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
  }
}
