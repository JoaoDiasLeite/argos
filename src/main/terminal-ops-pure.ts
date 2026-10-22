/**
 * The pure half of launching a CLI in an ops terminal (OPS_AGENT_PLAN.md §9, batch 5b):
 * the flags that put Claude Code behind the ops MCP server, the per-shell quoting they
 * travel through, and the rule for which terminals may carry an ops launch at all.
 *
 * Nothing here touches node-pty, the filesystem or Electron, so all of it is testable
 * as plain strings. terminal.ts does the spawning.
 */

export type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'unix' | 'wsl' | 'ssh'

/** What main hands a terminal so the CLI in it talks to the ops gate. */
export interface OpsTerminalLaunch {
  /** Inherited by the pty, so the relay the CLI spawns can reach Argos. */
  env: Record<string, string> // ARGOS_OPS_PIPE, ARGOS_OPS_TOKEN
  /** Claude: a JSON file for --mcp-config. Codex: a complete config.toml. Gemini: a settings JSON. */
  mcpConfigPath: string
}

/**
 * Claude Code's own tools that act on this machine or the network. With these removed
 * the only way the model can touch a server is through mcp__ops__*, which main gates.
 * Read/Glob/Grep stay: reading the local runbook folder is harmless and useful.
 */
export const OPS_DISALLOWED_TOOLS = [
  'Bash',
  // Not MultiEdit: current CLIs no longer have it and warn on every launch that the rule
  // "matches no known tool". On an older CLI that still does, a deny on Edit covers every
  // built-in tool that edits files, MultiEdit included.
  'Edit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Agent',
  'Task'
]

/**
 * The argv Claude Code needs to run as an ops client: only the ops server's MCP config
 * (`--strict-mcp-config` ignores the user's and the project's own servers), the ops
 * tools allowed without a CLI prompt (main asks instead), and the local tools gone.
 * Unquoted — quote with quoteArgs for the shell it goes through.
 */
export function claudeOpsFlags(mcpConfigPath: string): string[] {
  return [
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools',
    'mcp__ops__*',
    '--disallowedTools',
    OPS_DISALLOWED_TOOLS.join(',')
  ]
}

/** One token for a PowerShell command line: single quotes, embedded ones doubled. */
export function quotePwsh(token: string): string {
  return `'${token.replace(/'/g, "''")}'`
}

/** One token for a cmd.exe command line. */
export function quoteCmd(token: string): string {
  return `"${token}"`
}

/** One token for a POSIX shell command line. */
export function quoteUnix(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}

/** Quote every token for `kind`'s shell and join them with spaces. wsl and ssh end in a
 *  POSIX shell on the far side, so they quote as unix. */
export function quoteArgs(kind: ShellKind, args: string[]): string {
  const q = kind === 'pwsh' || kind === 'powershell' ? quotePwsh : kind === 'cmd' ? quoteCmd : quoteUnix
  return args.map(q).join(' ')
}

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * `K='v' K2='v' cmd` — env assignments that reach a CLI started on the far side of a
 * shell we only type into (wsl, ssh), where the pty's own environment does not follow.
 * A name that is not a valid shell identifier is dropped, never spliced in.
 */
export function withOpsEnvPrefix(cmd: string, env: Record<string, string>): string {
  const parts = Object.entries(env)
    .filter(([k]) => ENV_NAME_RE.test(k))
    .map(([k, v]) => `${k}=${quoteUnix(String(v))}`)
  return parts.length ? `${parts.join(' ')} ${cmd}` : cmd
}

/**
 * The Claude Code launch chain for `kind`, without any screen-clear prefix or line
 * terminator: resume-or-create pinned to `sessionId`, then a bare launch for a CLI too
 * old to know `--session-id`. `extra` (already quoted for `kind`) is appended to every
 * step, so a fallback can never start a Claude without the ops restrictions. `bin` is
 * the claude command for wsl/ssh (the remote path, possibly env-prefixed); the other kinds use their own CLAUDE_BIN reference.
 *
 * `withPrompt` hands the chat's first message to the step that CREATES the session, as
 * Claude Code's positional prompt (see initialPromptArg). Only that step: a --resume must
 * not be given the task a second time, and the bare fallback also runs after a session
 * that ended with an error, where it would do the same. It goes straight after the
 * session flag, ahead of `extra`, because --allowedTools and --disallowedTools are
 * variadic and would swallow a positional that followed them.
 */
export function claudeChain(
  kind: ShellKind,
  sessionId: string,
  createFirst: boolean,
  extra = '',
  bin?: string,
  withPrompt = false
): string {
  const arg = withPrompt ? initialPromptArg(kind) : null
  const p = arg ? ` ${arg}` : ''
  const create = `--session-id ${sessionId}${p}`
  const resume = `--resume ${sessionId}`
  const [first, second] = createFirst ? [create, resume] : [resume, create]
  const x = extra ? ` ${extra}` : ''
  if (kind === 'pwsh' || kind === 'powershell') {
    const b = '& $env:CLAUDE_BIN'
    return sessionId
      ? `${b} ${first}${x}; if ($LASTEXITCODE -ne 0) { ${b} ${second}${x}; if ($LASTEXITCODE -ne 0) { ${b}${x} } }`
      : `${b}${p}${x}`
  }
  const b = kind === 'cmd' ? '"%CLAUDE_BIN%"' : kind === 'wsl' || kind === 'ssh' ? bin || 'claude' : '"$CLAUDE_BIN"'
  return sessionId ? `${b} ${first}${x} || ${b} ${second}${x} || ${b}${x}` : `${b}${p}${x}`
}

/** The pty env variable that carries a chat's first message onto Claude Code's command line. */
export const INITIAL_PROMPT_ENV = 'ARGOS_INITIAL_PROMPT'

/**
 * How `kind`'s shell spells INITIAL_PROMPT_ENV as one argument, or null where the pty's
 * env does not reach the CLI (wsl, ssh: the launch is typed into a shell across a hop),
 * which keep typing the prompt in instead. A variable expansion rather than the text
 * itself, so free text never has to survive a shell's quoting rules.
 */
export function initialPromptArg(kind: ShellKind): string | null {
  if (kind === 'pwsh' || kind === 'powershell') return `"$env:${INITIAL_PROMPT_ENV}"`
  if (kind === 'cmd') return `"%${INITIAL_PROMPT_ENV}%"`
  if (kind === 'unix') return `"$${INITIAL_PROMPT_ENV}"`
  return null
}

/**
 * The value to put in INITIAL_PROMPT_ENV for `kind`, or null when the prompt should be
 * typed in instead (the shell cannot carry it, or there is nothing to send).
 *
 * A POSIX shell passes the value through whole. On Windows the expansion is not the end
 * of it: CLAUDE_BIN may be npm's claude.cmd, a batch file cmd.exe re-reads, where a line
 * break ends the command (the rest of the prompt is lost) and an embedded `"` closes the
 * argument early — and Windows PowerShell 5.1 does not escape one for a native command
 * either. So there line breaks become spaces and double quotes single ones: the model
 * reads the same request and the argument stays whole. A prompt that starts with `-`
 * would be read as a flag, so that one is typed in too.
 */
export function initialPromptValue(kind: ShellKind, prompt: string | undefined): string | null {
  if (!prompt || !initialPromptArg(kind)) return null
  let v = prompt.trim()
  if (kind !== 'unix') v = v.replace(/\s*[\r\n]+\s*/g, ' ').replace(/"/g, "'")
  if (!v || v.startsWith('-')) return null
  return v
}

/**
 * Recognise a WSL share path — \\wsl.localhost\<distro>\rest or \\wsl$\<distro>\rest.
 * A local chat pointed at one still opens its terminal inside that distro.
 */
export function parseWslUnc(p?: string): { distro: string; linuxPath: string } | null {
  if (!p) return null
  const m = p.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?(.*)$/i)
  if (!m) return null
  return { distro: m[1], linuxPath: '/' + m[2].replace(/\\/g, '/') }
}

export const OPS_LOCAL_ONLY_ERROR = 'Ops terminals run in a local shell in this version.'

/**
 * Why an ops launch cannot go ahead in the terminal these options describe, or null.
 *
 * Local shells only in this phase. The relay the CLI spawns has to reach Argos over
 * ARGOS_OPS_PIPE, and on Windows that is a named pipe: a WSL distro cannot open a
 * Windows named pipe, and an SSH box would need the relay running on the server, which
 * the plan rules out. The same test createTerminal uses to pick the shell decides it:
 * a remote host, an explicit distro, or (on Windows) a folder on a WSL share.
 */
export function opsLaunchRefusal(
  opts: { ops?: unknown; remoteHostId?: string; wslDistro?: string; cwd?: string },
  platform: string
): string | null {
  if (!opts.ops) return null
  if (opts.remoteHostId) return OPS_LOCAL_ONLY_ERROR
  if (platform === 'win32' && (opts.wslDistro || parseWslUnc(opts.cwd))) return OPS_LOCAL_ONLY_ERROR
  return null
}

/** Is this a usable ops launch? Anything else is treated as no ops at all by the caller
 *  — which then refuses, rather than starting an ungated CLI under an ops chat. */
export function isOpsLaunch(v: unknown): v is OpsTerminalLaunch {
  if (!v || typeof v !== 'object') return false
  const o = v as { env?: unknown; mcpConfigPath?: unknown }
  if (typeof o.mcpConfigPath !== 'string' || !o.mcpConfigPath) return false
  if (!o.env || typeof o.env !== 'object') return false
  return Object.values(o.env as Record<string, unknown>).every((x) => typeof x === 'string')
}
