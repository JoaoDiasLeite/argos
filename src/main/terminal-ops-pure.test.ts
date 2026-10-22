import { describe, it, expect } from 'vitest'
import {
  claudeChain,
  claudeOpsFlags,
  initialPromptArg,
  initialPromptValue,
  isOpsLaunch,
  OPS_LOCAL_ONLY_ERROR,
  opsLaunchRefusal,
  opsPluginSettings,
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

describe('claudeChain with the first message', () => {
  const extra = quoteArgs('pwsh', claudeOpsFlags(WIN_PATH))

  it('pwsh: the prompt rides on the create step only, ahead of the ops flags', () => {
    expect(claudeChain('pwsh', SID, true, extra, undefined, true)).toBe(
      `& $env:CLAUDE_BIN --session-id ${SID} "$env:ARGOS_INITIAL_PROMPT" ${extra}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN --resume ${SID} ${extra}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN ${extra} } }`
    )
    expect(claudeChain('powershell', SID, true, '', undefined, true)).toBe(
      `& $env:CLAUDE_BIN --session-id ${SID} "$env:ARGOS_INITIAL_PROMPT"; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN --resume ${SID}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN } }`
    )
  })

  it('cmd and unix: the exact create lines', () => {
    expect(claudeChain('cmd', SID, true, '', undefined, true)).toBe(
      `"%CLAUDE_BIN%" --session-id ${SID} "%ARGOS_INITIAL_PROMPT%" || "%CLAUDE_BIN%" --resume ${SID} || "%CLAUDE_BIN%"`
    )
    expect(claudeChain('unix', SID, true, '', undefined, true)).toBe(
      `"$CLAUDE_BIN" --session-id ${SID} "$ARGOS_INITIAL_PROMPT" || "$CLAUDE_BIN" --resume ${SID} || "$CLAUDE_BIN"`
    )
  })

  it('never puts it on a resume or the bare fallback', () => {
    for (const kind of ['pwsh', 'cmd', 'unix'] as const) {
      const line = claudeChain(kind, SID, false, '', undefined, true)
      expect(line.split('ARGOS_INITIAL_PROMPT').length - 1).toBe(1)
      expect(line).toContain(`--session-id ${SID} ${initialPromptArg(kind)}`)
      expect(line).not.toContain(`--resume ${SID} ${initialPromptArg(kind)}`)
    }
  })

  it('a launch with no session id carries it on its one step', () => {
    expect(claudeChain('unix', '', false, '', undefined, true)).toBe('"$CLAUDE_BIN" "$ARGOS_INITIAL_PROMPT"')
    expect(claudeChain('pwsh', '', false, extra, undefined, true)).toBe(`& $env:CLAUDE_BIN "$env:ARGOS_INITIAL_PROMPT" ${extra}`)
  })

  it('is left off wsl and ssh, where the pty env does not reach the CLI', () => {
    expect(initialPromptArg('wsl')).toBeNull()
    expect(initialPromptArg('ssh')).toBeNull()
    expect(claudeChain('wsl', SID, true, '', undefined, true)).toBe(claudeChain('wsl', SID, true))
  })
})

describe('initialPromptValue', () => {
  it('passes a POSIX shell the text whole', () => {
    expect(initialPromptValue('unix', ' say "hi"\nthen $stop ')).toBe('say "hi"\nthen $stop')
  })

  it('on Windows folds line breaks and double quotes, which a .cmd shim would cut at', () => {
    for (const kind of ['pwsh', 'powershell', 'cmd'] as const) {
      expect(initialPromptValue(kind, 'fix "the" bug\r\n\r\n  then test it')).toBe("fix 'the' bug then test it")
    }
  })

  it('leaves to typing what the command line cannot carry', () => {
    expect(initialPromptValue('pwsh', undefined)).toBeNull()
    expect(initialPromptValue('pwsh', '  \n ')).toBeNull()
    expect(initialPromptValue('unix', '--help me')).toBeNull()
    expect(initialPromptValue('wsl', 'hello')).toBeNull()
    expect(initialPromptValue('ssh', 'hello')).toBeNull()
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

describe('opsPluginSettings', () => {
  it('switches off every plugin the user enables, and only those', () => {
    const user = { enabledPlugins: { 'mempalace@mempalace': true, 'wm-hud@wm-devsecops': true, 'old@x': false }, statusLine: {} }
    expect(opsPluginSettings(user)).toEqual({ enabledPlugins: { 'mempalace@mempalace': false, 'wm-hud@wm-devsecops': false } })
  })

  it('is null when nothing is enabled or the settings are not an object', () => {
    expect(opsPluginSettings({})).toBeNull()
    expect(opsPluginSettings({ enabledPlugins: { a: false } })).toBeNull()
    expect(opsPluginSettings(null)).toBeNull()
    expect(opsPluginSettings('x')).toBeNull()
  })
})

describe('claudeOpsFlags with a settings overlay', () => {
  it('puts --settings before the list flags that would swallow it', () => {
    const f = claudeOpsFlags('/m.json', '/s.json')
    expect(f.slice(0, 5)).toEqual(['--mcp-config', '/m.json', '--strict-mcp-config', '--settings', '/s.json'])
    expect(f.indexOf('--settings')).toBeLessThan(f.indexOf('--allowedTools'))
  })

  it('leaves --settings out without an overlay', () => {
    expect(claudeOpsFlags('/m.json')).not.toContain('--settings')
  })
})
