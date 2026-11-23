export type McpServerAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'headers'; headers: { key: string; value: string }[] }

export type McpCachedTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type McpServerConfig = {
  id: string
  name: string
  url: string
  auth: McpServerAuth
  enabled: boolean
  /** false（默认）：该服务下任何工具调用前弹出确认条；true：静默自动执行 */
  autoApprove: boolean
  /** 用户在服务详情页手动禁用的原始工具名列表 */
  disabledTools: string[]
  cachedTools: McpCachedTool[]
  lastConnectedAt?: number
}

export type McpTransportMode = 'streamable' | 'legacy-sse'
