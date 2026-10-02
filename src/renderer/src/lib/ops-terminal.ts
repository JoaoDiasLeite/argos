/** Shapes shared by the Ops workspace and ChatTerminal for an ops terminal launch. The IPC
 *  itself is typed on window.electronAPI (types.ts); these name its pieces. */

/** The CLI an ops terminal launches. */
export type OpsTerminalProvider = 'claude' | 'codex' | 'gemini'

/** What the CLI's pty needs to reach the ops relay: its token env and the MCP config. */
export interface OpsTerminalLaunch {
  env: Record<string, string>
  mcpConfigPath: string
}

export type OpsTerminalSessionResult = Awaited<ReturnType<typeof window.electronAPI.opsTerminalSession>>
