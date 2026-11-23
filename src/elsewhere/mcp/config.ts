import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import type { McpCachedTool, McpServerAuth, McpServerConfig } from './types.js'

const STORAGE_KEY = 'elsewhere:mcp-servers'
const MAX_TOOL_NAME_LENGTH = 64

export const normalizeMcpUrl = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (!/^https?:\/\//i.test(trimmed)) {
    return null
  }
  try {
    const parsed = new URL(trimmed)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      return null
    }
    return parsed.toString()
  } catch {
    return null
  }
}

export const normalizeMcpInputSchema = (schema: unknown): Record<string, unknown> => {
  if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
    const record = schema as Record<string, unknown>
    if (record.type === 'object') {
      return record
    }
    if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
      return { ...record, type: 'object' }
    }
  }
  return { type: 'object', properties: {} }
}

export const sanitizeToolSlug = (raw: string, fallback: string): string => {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
  return cleaned || fallback
}

const fnv1aHex = (text: string): string => {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export const buildMcpRegisteredToolName = (
  server: Pick<McpServerConfig, 'id' | 'name'>,
  rawToolName: string,
  usedNames: ReadonlySet<string>
): string => {
  const serverSlug = sanitizeToolSlug(server.name, sanitizeToolSlug(server.id, 'server')).slice(0, 18)
  const toolSlug = sanitizeToolSlug(rawToolName, 'tool')
  const base = `mcp__${serverSlug}__${toolSlug}`
  const hash = fnv1aHex(`${server.id}:${rawToolName}`)

  if (base.length <= MAX_TOOL_NAME_LENGTH && !usedNames.has(base)) {
    return base
  }

  const maxHead = MAX_TOOL_NAME_LENGTH - hash.length - 1
  let candidate = `${base.slice(0, maxHead)}_${hash}`
  let counter = 1
  while (usedNames.has(candidate)) {
    const suffix = `_${hash.slice(0, 5)}_${counter}`
    candidate = `${base.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`
    counter += 1
  }
  return candidate
}

export const buildMcpAuthHeaders = (auth: McpServerAuth): Record<string, string> => {
  if (auth.type === 'bearer') {
    const token = auth.token.trim()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }
  if (auth.type === 'headers') {
    const headers: Record<string, string> = {}
    for (const entry of auth.headers) {
      const key = entry.key.trim()
      if (key && !/[\r\n]/.test(key) && !/[\r\n]/.test(entry.value)) {
        headers[key] = entry.value.trim()
      }
    }
    return headers
  }
  return {}
}

const normalizeAuth = (raw: unknown): McpServerAuth => {
  if (!raw || typeof raw !== 'object') {
    return { type: 'none' }
  }
  const obj = raw as Record<string, unknown>
  if (obj.type === 'bearer' && typeof obj.token === 'string') {
    return { type: 'bearer', token: obj.token }
  }
  if (obj.type === 'headers' && Array.isArray(obj.headers)) {
    const list: { key: string; value: string }[] = []
    for (const item of obj.headers) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).key === 'string' &&
        typeof (item as Record<string, unknown>).value === 'string'
      ) {
        list.push({
          key: (item as Record<string, string>).key,
          value: (item as Record<string, string>).value,
        })
      }
    }
    return { type: 'headers', headers: list }
  }
  return { type: 'none' }
}

const normalizeCachedTool = (raw: unknown): McpCachedTool | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    return null
  }
  return {
    name: obj.name.trim(),
    description: typeof obj.description === 'string' ? obj.description : '',
    inputSchema: normalizeMcpInputSchema(obj.inputSchema),
  }
}

const normalizeServerConfig = (raw: unknown): McpServerConfig | null => {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  if (typeof obj.id !== 'string' || !obj.id || typeof obj.url !== 'string') {
    return null
  }
  const url = normalizeMcpUrl(obj.url)
  if (!url) {
    return null
  }
  const disabledTools = Array.isArray(obj.disabledTools)
    ? obj.disabledTools.filter((item): item is string => typeof item === 'string')
    : []
  const cachedTools = Array.isArray(obj.cachedTools)
    ? obj.cachedTools
        .map(normalizeCachedTool)
        .filter((item): item is McpCachedTool => item !== null)
    : []
  return {
    id: obj.id,
    name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : new URL(url).hostname,
    url,
    auth: normalizeAuth(obj.auth),
    enabled: obj.enabled !== false,
    autoApprove: obj.autoApprove === true,
    disabledTools,
    cachedTools,
    ...(typeof obj.lastConnectedAt === 'number' ? { lastConnectedAt: obj.lastConnectedAt } : {}),
  }
}

type McpServersState = {
  servers: McpServerConfig[]
}

const readStored = (): McpServerConfig[] => {
  if (typeof localStorage === 'undefined') {
    return []
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .map(normalizeServerConfig)
      .filter((item): item is McpServerConfig => item !== null)
  } catch {
    return []
  }
}

const persistServers = (servers: McpServerConfig[]) => {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers))
  } catch {
    // Keep memory state if localStorage is restricted
  }
}

export const useMcpServers = create<McpServersState>(() => ({ servers: readStored() }))

const updateServers = (updater: (current: McpServerConfig[]) => McpServerConfig[]) => {
  const next = updater(useMcpServers.getState().servers)
  persistServers(next)
  useMcpServers.setState({ servers: next })
}

export const addMcpServer = (input: {
  name: string
  url: string
  auth: McpServerAuth
  cachedTools?: McpCachedTool[]
  lastConnectedAt?: number
  enabled?: boolean
  autoApprove?: boolean
}): McpServerConfig => {
  const normalizedUrl = normalizeMcpUrl(input.url)
  if (!normalizedUrl) {
    throw new Error('Invalid MCP server URL')
  }
  const server: McpServerConfig = {
    id: createId(),
    name: input.name.trim() || new URL(normalizedUrl).hostname,
    url: normalizedUrl,
    auth: input.auth,
    enabled: input.enabled ?? true,
    autoApprove: input.autoApprove ?? false,
    disabledTools: [],
    cachedTools: (input.cachedTools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: normalizeMcpInputSchema(tool.inputSchema),
    })),
    ...(input.lastConnectedAt !== undefined ? { lastConnectedAt: input.lastConnectedAt } : {}),
  }
  updateServers((current) => [...current, server])
  return server
}

export const updateMcpServer = (
  serverId: string,
  updater: (server: McpServerConfig) => McpServerConfig
) => {
  updateServers((current) =>
    current.map((item) => (item.id === serverId ? updater(item) : item))
  )
}

export const removeMcpServer = (serverId: string) => {
  updateServers((current) => current.filter((item) => item.id !== serverId))
}

export const setMcpServerEnabled = (serverId: string, enabled: boolean) => {
  updateMcpServer(serverId, (server) => ({ ...server, enabled }))
}

export const setMcpServerAutoApprove = (serverId: string, autoApprove: boolean) => {
  updateMcpServer(serverId, (server) => ({ ...server, autoApprove }))
}

export const setMcpToolEnabled = (serverId: string, rawToolName: string, enabled: boolean) => {
  updateMcpServer(serverId, (server) => {
    const disabled = new Set(server.disabledTools)
    if (enabled) {
      disabled.delete(rawToolName)
    } else {
      disabled.add(rawToolName)
    }
    return { ...server, disabledTools: Array.from(disabled) }
  })
}

export const setMcpServerCachedTools = (
  serverId: string,
  tools: McpCachedTool[],
  connectedAt = Date.now()
) => {
  updateMcpServer(serverId, (server) => {
    const available = new Set(tools.map((item) => item.name))
    return {
      ...server,
      cachedTools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: normalizeMcpInputSchema(tool.inputSchema),
      })),
      disabledTools: server.disabledTools.filter((name) => available.has(name)),
      lastConnectedAt: connectedAt,
    }
  })
}

export const getEnabledMcpToolsCount = (server: McpServerConfig): number => {
  if (!server.enabled) {
    return 0
  }
  const disabled = new Set(server.disabledTools)
  return server.cachedTools.filter((tool) => !disabled.has(tool.name)).length
}

export const replaceAllMcpServersForTest = (servers: McpServerConfig[]) => {
  persistServers(servers)
  useMcpServers.setState({ servers })
}
