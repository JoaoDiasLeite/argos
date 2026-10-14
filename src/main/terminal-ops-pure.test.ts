import { describe, it, expect } from 'vitest'
import {
  claudeChain,
  claudeOpsFlags,
  isOpsLaunch,
  OPS_LOCAL_ONLY_ERROR,
  opsLaunchRefusal,
  quoteArgs,
  withOpsEnvPrefix
} from './terminal-ops-pure'

const WIN_PATH = 'C:\\Users\\Jo Leite\\AppData\\Roaming\\argos\\ops-mcp\\t1\\claude.json'
const UNIX_PATH = '/home/jo leite/.config/argos/ops-mcp/t1/claude.json'
const SID = '0b5c1d2e-aaaa-bbbb-cccc-1234567890ab'
const DISALLOWED = 'Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch,Agent,Task'

describe('claudeOpsFlags', () => {
  it('points at the ops config only, allows the ops tools and removes the local ones', () => {
    expect(claudeOpsFlags(WIN_PATH)).toEqual([
      '--mcp-config',
      WIN_PATH,
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__ops__*',
      '--disallowedTools',
      DISALLOWED
    ])
  })
})

describe('quoteArgs for the ops flags', () => {
  it('pwsh: single quotes, the path with a space kept whole', () => {
    expect(quoteArgs('pwsh', claudeOpsFlags(WIN_PATH))).toBe(
      `'--mcp-config' '${WIN_PATH}' '--strict-mcp-config' '--allowedTools' 'mcp__ops__*' '--disallowedTools' '${DISALLOWED}'`
    )
  })

  it('pwsh: an embedded single quote is doubled', () => {
    expect(quoteArgs('powershell', ["C:\\O'Brien dir\\c.json"])).toBe(`'C:\\O''Brien dir\\c.json'`)
  })

  it('cmd: double quotes', () => {
    expect(quoteArgs('cmd', claudeOpsFlags(WIN_PATH))).toBe(
      `"--mcp-config" "${WIN_PATH}" "--strict-mcp-config" "--allowedTools" "mcp__ops__*" "--disallowedTools" "${DISALLOWED}"`
    )
  })

  it('unix: single quotes, the glob not left for the shell to expand', () => {
    expect(quoteArgs('unix', claudeOpsFlags(UNIX_PATH))).toBe(
      `'--mcp-config' '${UNIX_PATH}' '--strict-mcp-config' '--allowedTools' 'mcp__ops__*' '--disallowedTools' '${DISALLOWED}'`
    )
    expect(quoteArgs('unix', ["it's"])).toBe(`'it'\\''s'`)
  })
})

describe('claudeChain', () => {
  const count = (s: string, sub: string): number => s.split(sub).length - 1

  it('is unchanged without ops', () => {
    expect(claudeChain('pwsh', SID, false)).toBe(
      `& $env:CLAUDE_BIN --resume ${SID}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN --session-id ${SID}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN } }`
    )
    expect(claudeChain('cmd', SID, true)).toBe(
      `"%CLAUDE_BIN%" --session-id ${SID} || "%CLAUDE_BIN%" --resume ${SID} || "%CLAUDE_BIN%"`
    )
    expect(claudeChain('unix', '', false)).toBe(`"$CLAUDE_BIN"`)
    expect(claudeChain('wsl', SID, false)).toBe(`claude --resume ${SID} || claude --session-id ${SID} || claude`)
    expect(claudeChain('ssh', '', false, '', '/opt/claude')).toBe('/opt/claude')
  })

  for (const kind of ['pwsh', 'cmd', 'unix'] as const) {
    it(`${kind}: keeps the ops flags on all three steps`, () => {
      const extra = quoteArgs(kind, claudeOpsFlags(kind === 'unix' ? UNIX_PATH : WIN_PATH))
      const line = claudeChain(kind, SID, false, extra)
      expect(count(line, extra)).toBe(3)
      expect(count(line, 'mcp__ops__*')).toBe(3)
      expect(count(line, '--strict-mcp-config')).toBe(3)
    })
  }

  it('pwsh: the exact ops launch line', () => {
    const extra = quoteArgs('pwsh', claudeOpsFlags(WIN_PATH))
    expect(claudeChain('pwsh', SID, true, extra)).toBe(
      `& $env:CLAUDE_BIN --session-id ${SID} ${extra}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN --resume ${SID} ${extra}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN ${extra} } }`
    )
  })

  it('keeps the flags on a launch with no session id', () => {
    const extra = quoteArgs('unix', claudeOpsFlags(UNIX_PATH))
    expect(claudeChain('unix', '', false, extra)).toBe(`"$CLAUDE_BIN" ${extra}`)
  })
})

describe('withOpsEnvPrefix', () => {
  it('puts quoted assignments in front of the command', () => {
    expect(
      withOpsEnvPrefix('claude', { ARGOS_OPS_PIPE: '/run/user/1000/argos-ops-ab', ARGOS_OPS_TOKEN: "t'k" })
    ).toBe(`ARGOS_OPS_PIPE='/run/user/1000/argos-ops-ab' ARGOS_OPS_TOKEN='t'\\''k' claude`)
  })

  it('drops a name that is not a shell identifier, and is a no-op with no env', () => {
    expect(withOpsEnvPrefix('claude', { 'A;rm -rf /': 'x', OK: 'y' })).toBe(`OK='y' claude`)
    expect(withOpsEnvPrefix('claude', {})).toBe('claude')
  })

  it('reaches every step when used as the wsl/ssh bin', () => {
    const bin = withOpsEnvPrefix('claude', { ARGOS_OPS_TOKEN: 'tok' })
    const line = claudeChain('wsl', SID, false, '', bin)
    expect(line.split(`ARGOS_OPS_TOKEN='tok' claude`).length - 1).toBe(3)
  })
})

describe('opsLaunchRefusal', () => {
  const ops = { env: { ARGOS_OPS_PIPE: 'p', ARGOS_OPS_TOKEN: 't' }, mcpConfigPath: WIN_PATH }

  it('refuses an ops launch over ssh', () => {
    expect(opsLaunchRefusal({ ops, remoteHostId: 'h1' }, 'win32')).toBe(OPS_LOCAL_ONLY_ERROR)
    expect(opsLaunchRefusal({ ops, remoteHostId: 'h1' }, 'linux')).toBe(OPS_LOCAL_ONLY_ERROR)
  })

  it('refuses an ops launch in WSL, explicit or through a share path', () => {
    expect(opsLaunchRefusal({ ops, wslDistro: 'Ubuntu' }, 'win32')).toBe(OPS_LOCAL_ONLY_ERROR)
    expect(opsLaunchRefusal({ ops, cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jo' }, 'win32')).toBe(OPS_LOCAL_ONLY_ERROR)
    expect(opsLaunchRefusal({ ops, cwd: '\\\\wsl$\\Ubuntu' }, 'win32')).toBe(OPS_LOCAL_ONLY_ERROR)
  })

  it('allows a local shell, and has nothing to say without ops', () => {
    expect(opsLaunchRefusal({ ops, cwd: 'C:\\work' }, 'win32')).toBeNull()
    expect(opsLaunchRefusal({ ops, wslDistro: 'Ubuntu' }, 'linux')).toBeNull()
    expect(opsLaunchRefusal({ remoteHostId: 'h1' }, 'win32')).toBeNull()
  })
})

describe('isOpsLaunch', () => {
  it('accepts the contract shape and rejects anything else', () => {
    expect(isOpsLaunch({ env: { ARGOS_OPS_TOKEN: 't' }, mcpConfigPath: '/x.json' })).toBe(true)
    expect(isOpsLaunch({ env: {}, mcpConfigPath: '' })).toBe(false)
    expect(isOpsLaunch({ env: { A: 1 }, mcpConfigPath: '/x.json' })).toBe(false)
    expect(isOpsLaunch({ mcpConfigPath: '/x.json' })).toBe(false)
    expect(isOpsLaunch(null)).toBe(false)
  })
})
