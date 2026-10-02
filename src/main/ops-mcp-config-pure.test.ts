import { describe, it, expect } from 'vitest'
import { opsMcpConfigFile, opsRelayCommand, OPS_CLI_TOOL_TIMEOUT_SEC } from './ops-mcp-config-pure'

const join = (...p: string[]) => p.join('\\')
const relay = opsRelayCommand('C:\\Program Files\\Argos\\Argos.exe', 'C:\\Program Files\\Argos\\resources\\app.asar', join)
const env = { ARGOS_OPS_PIPE: '\\\\.\\pipe\\argos-ops-abc', ARGOS_OPS_TOKEN: '0123456789abcdef0123456789abcdef' }

describe('opsRelayCommand', () => {
  it('runs the relay bundle as node, with the flag on the line', () => {
    expect(relay).toEqual({
      command: 'C:\\Program Files\\Argos\\Argos.exe',
      args: ['C:\\Program Files\\Argos\\resources\\app.asar\\out\\main\\ops-relay.js', '--ops-mcp'],
      env: { ELECTRON_RUN_AS_NODE: '1' }
    })
  })
})

describe('opsMcpConfigFile', () => {
  const server = { command: relay.command, args: relay.args, env: { ELECTRON_RUN_AS_NODE: '1', ...env } }

  it('Claude Code: mcp.json for --mcp-config', () => {
    const f = opsMcpConfigFile('claude', relay, env)
    expect(f.fileName).toBe('mcp.json')
    expect(JSON.parse(f.content)).toEqual({ mcpServers: { ops: server } })
  })

  it('Gemini: system settings with the server and a long tool timeout', () => {
    const f = opsMcpConfigFile('gemini', relay, env)
    expect(f.fileName).toBe('settings.json')
    expect(JSON.parse(f.content)).toEqual({ mcpServers: { ops: { ...server, timeout: OPS_CLI_TOOL_TIMEOUT_SEC * 1000 } } })
  })

  it('Codex: a complete config.toml with the server, its env, timeouts and the runbook trusted', () => {
    const f = opsMcpConfigFile('codex', relay, env, { runbookPath: 'C:\\runbooks\\nginx "x"' })
    expect(f.fileName).toBe('config.toml')
    expect(f.content).toBe(
      [
        '[mcp_servers.ops]',
        'command = "C:\\\\Program Files\\\\Argos\\\\Argos.exe"',
        'args = ["C:\\\\Program Files\\\\Argos\\\\resources\\\\app.asar\\\\out\\\\main\\\\ops-relay.js", "--ops-mcp"]',
        'env = { "ELECTRON_RUN_AS_NODE" = "1", "ARGOS_OPS_PIPE" = "\\\\\\\\.\\\\pipe\\\\argos-ops-abc", "ARGOS_OPS_TOKEN" = "0123456789abcdef0123456789abcdef" }',
        'startup_timeout_sec = 30',
        `tool_timeout_sec = ${OPS_CLI_TOOL_TIMEOUT_SEC}`,
        '',
        '[projects."C:\\\\runbooks\\\\nginx \\"x\\""]',
        'trust_level = "trusted"',
        ''
      ].join('\n')
    )
  })

  it('Codex without a runbook path has no projects table', () => {
    expect(opsMcpConfigFile('codex', relay, env).content).not.toMatch(/\[projects/)
  })

  it('the session env wins over the relay env', () => {
    const f = opsMcpConfigFile('claude', { ...relay, env: { ELECTRON_RUN_AS_NODE: '1', ARGOS_OPS_TOKEN: 'stale' } }, env)
    expect(JSON.parse(f.content).mcpServers.ops.env.ARGOS_OPS_TOKEN).toBe(env.ARGOS_OPS_TOKEN)
  })
})
