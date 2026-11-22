export type ToolSource = 'builtin' | 'mcp'

export type SearchEngineId = 'deepseek' | 'bocha' | 'exa' | 'tavily' | 'brave' | 'searxng'

export type WebFetchMode = 'auto' | 'off'

export type NormalizedSearchResult = {
  title: string
  url: string
  snippet: string
  siteName?: string | null
  siteIcon?: string | null
  publishedAt?: string | null
}

export type SearchEngineKeyId = Exclude<SearchEngineId, 'deepseek' | 'searxng'>

export type SearchToolsRuntimeConfig = {
  engine: SearchEngineId
  officialApiKey: string
  apiKeys: Partial<Record<SearchEngineKeyId, string>>
  searxngUrl: string
  webFetchMode: WebFetchMode
  useExternalOnOfficial: boolean
}

export type ToolExecutionContext = {
  signal: AbortSignal
  /** 本轮搜索/抓取所需的当前运行时配置 */
  config: SearchToolsRuntimeConfig
}

export type ToolExecutionResult = {
  /** 返回给模型的纯文本或紧凑 JSON 字符串（已做长度截断） */
  content: string
  isError?: boolean
  /** 供 UI 渲染来源面板与时间线摘要的结构化元数据 */
  meta?:
    | { kind: 'search'; engine: SearchEngineId; queries: string[]; results: NormalizedSearchResult[] }
    | { kind: 'fetch'; url: string; title: string | null; truncated: boolean; charCount: number }
    | { kind: 'generic'; summary?: string }
}

export type ClientToolDefinition = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  source: ToolSource
  serverName?: string
  readOnly: boolean
  execute: (input: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>
}

export type ClientToolCallStatus = 'running' | 'done' | 'error' | 'stopped' | 'aborted_loop'

export type ClientToolCallBlock = {
  type: 'client_tool_call'
  id: string
  name: string
  source: ToolSource
  serverName?: string
  input: Record<string, unknown>
  rawInput?: string
  status: ClientToolCallStatus
  output?: string
  error?: string
  startedAt: number
  endedAt?: number
  meta?: ToolExecutionResult['meta']
}
