/**
 * The `ops` MCP server entry as each CLI reads it (docs/OPS_AGENT_PLAN.md §9 Phase 5).
 * Written by main under `userData/ops-mcp/<terminalId>/` and handed to the terminal:
 *
 * - Claude Code: `mcp.json`, `{ "mcpServers": { "ops": { command, args, env } } }`, for
 *   `--mcp-config <path>`.
 * - Codex: `config.toml`, the COMPLETE config of an overlay CODEX_HOME: the
 *   `[mcp_servers.ops]` table in the shape providers/codex.ts `toCodexMcpToml` writes,
 *   plus the runbook folder marked trusted so Codex does not ask on every launch.
 * - Gemini: `settings.json`, `{ "mcpServers": { "ops": … } }`, the system-settings
 *   overlay (GEMINI_CLI_SYSTEM_SETTINGS_PATH), the shape `toGeminiMcpServers` writes.
 *
 * The token goes in the server's own `env`, not only the pty's: Codex starts MCP servers
 * with a cleared environment plus the entry's `env`, so an inherited variable would not
 * reach the relay there.
 */

export type OpsCli = 'claude' | 'codex' | 'gemini'

export interface OpsRelayCommand {
  command: string
  args: string[]
  /** Variables the relay itself needs (ELECTRON_RUN_AS_NODE). Merged under the session env. */
  env?: Record<string, string>
}

/**
 * How long a CLI should wait on one ops call. A call can wait for the operator at the
 * approval modal and then run for the policy's timeout (≤ 10 min, OPS_MAX_TIMEOUT_MS);
 * the CLIs' defaults (60 s for Codex) would cut that off.
 */
export const OPS_CLI_TOOL_TIMEOUT_SEC = 30 * 60

/**
 * The relay as a command. `ELECTRON_RUN_AS_NODE=1` with the relay's own bundle, not the
 * app's main entry with `--ops-mcp`: Electron's main process writes a stray CRLF to
 * stdout at startup and its `process.stdin` stream delivers nothing on Windows (both
 * measured), and stdout is the MCP channel. Node mode has neither problem, starts no
 * Chromium, and never touches userData. `--ops-mcp` stays on the line so the process is
 * recognisable in a process list. Works the same packaged (the bundle is read from
 * app.asar) and in dev (electron.exe + the project's out/main).
 */
export function opsRelayCommand(execPath: string, appPath: string, join: (...p: string[]) => string): OpsRelayCommand {
  return {
    command: execPath,
    args: [join(appPath, 'out', 'main', 'ops-relay.js'), '--ops-mcp'],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  }
}

/** A TOML basic string. JSON's escapes (\\ \" \n \uXXXX) are all valid TOML. */
function tomlString(s: string): string {
  return JSON.stringify(s)
}

export interface OpsMcpConfigFile {
  fileName: string
  content: string
}

export function opsMcpConfigFile(
  provider: OpsCli,
  relay: OpsRelayCommand,
  env: Record<string, string>,
  opts: { runbookPath?: string } = {}
): OpsMcpConfigFile {
  const serverEnv = { ...(relay.env ?? {}), ...env }
  const server = { command: relay.command, args: [...relay.args], env: serverEnv }
  switch (provider) {
    case 'claude':
      return { fileName: 'mcp.json', content: `${JSON.stringify({ mcpServers: { ops: server } }, null, 2)}\n` }
    case 'gemini':
      return {
        fileName: 'settings.json',
        content: `${JSON.stringify({ mcpServers: { ops: { ...server, timeout: OPS_CLI_TOOL_TIMEOUT_SEC * 1000 } } }, null, 2)}\n`
      }
    case 'codex': {
      const lines = [
        '[mcp_servers.ops]',
        `command = ${tomlString(server.command)}`,
        `args = [${server.args.map(tomlString).join(', ')}]`,
        `env = { ${Object.entries(serverEnv)
          .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`)
          .join(', ')} }`,
        'startup_timeout_sec = 30',
        `tool_timeout_sec = ${OPS_CLI_TOOL_TIMEOUT_SEC}`
      ]
      if (opts.runbookPath) lines.push('', `[projects.${tomlString(opts.runbookPath)}]`, 'trust_level = "trusted"')
      return { fileName: 'config.toml', content: `${lines.join('\n')}\n` }
    }
  }
}
