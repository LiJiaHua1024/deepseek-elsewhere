import type { ClientToolDefinition } from '../tools/types.js'
import { buildMcpRegisteredToolName, normalizeMcpInputSchema, useMcpServers } from './config.js'
import { mcpClient } from './protocol.js'

export const buildActiveMcpTools = (
  usedNames: Set<string> = new Set()
): ClientToolDefinition[] => {
  const { servers } = useMcpServers.getState()
  const tools: ClientToolDefinition[] = []

  for (const server of servers) {
    if (!server.enabled) {
      continue
    }
    const disabled = new Set(server.disabledTools)
    for (const cached of server.cachedTools) {
      if (disabled.has(cached.name)) {
        continue
      }
      const registeredName = buildMcpRegisteredToolName(server, cached.name, usedNames)
      usedNames.add(registeredName)
      tools.push({
        name: registeredName,
        displayName: cached.name,
        description: cached.description || `Call ${cached.name} on ${server.name}.`,
        inputSchema: normalizeMcpInputSchema(cached.inputSchema),
        source: 'mcp',
        serverId: server.id,
        serverName: server.name,
        autoApprove: server.autoApprove,
        readOnly: false,
        execute: async (input, ctx) => {
          try {
            return await mcpClient.callTool(server, cached.name, input, ctx.signal)
          } catch (error) {
            if (ctx.signal.aborted) {
              throw error
            }
            return {
              content: error instanceof Error ? error.message : String(error),
              isError: true,
            }
          }
        },
      })
    }
  }

  return tools
}
