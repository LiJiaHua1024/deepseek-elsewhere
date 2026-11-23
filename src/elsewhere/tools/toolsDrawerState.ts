import { create } from 'zustand'
import { getEnabledMcpToolsCount, useMcpServers } from '../mcp/config.js'
import { useBuiltinToolsConfig } from '../python/config.js'
import { usePyodideRuntime } from '../python/runtimeState.js'

type ToolsDrawerState = {
  open: boolean
}

export const useToolsDrawer = create<ToolsDrawerState>(() => ({ open: false }))

export const openToolsDrawer = () => useToolsDrawer.setState({ open: true })

export const closeToolsDrawer = () => useToolsDrawer.setState({ open: false })

export const useActiveToolsCount = (): number => {
  const pythonEnabled = useBuiltinToolsConfig((state) => state.pythonEnabled)
  const historySearchEnabled = useBuiltinToolsConfig((state) => state.historySearchEnabled)
  const pyodideInstalled = usePyodideRuntime((state) => state.installed)
  const servers = useMcpServers((state) => state.servers)

  const mcpCount = servers.filter((server) => getEnabledMcpToolsCount(server) > 0).length
  return (pythonEnabled && pyodideInstalled ? 1 : 0) + (historySearchEnabled ? 1 : 0) + mcpCount
}
