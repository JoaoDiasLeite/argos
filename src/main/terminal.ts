import * as pty from 'node-pty'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import { buildSubprocessEnv } from './auth'
import { accountConfigDir, resolveClaudeBin } from './accounts'
import { providerAccountEnv } from './provider-accounts'
import { resolveCodex } from './providers/cli-resolve'
import { getSshTerminalCommand } from './ssh'

/**
 * Embedded real terminal (PTY) support, so the user can run the actual interactive
 * `claude` CLI inside the app, reusing their existing Claude Code login/accounts.
 *
 * Terminals are keyed by a renderer-supplied id, always validated against a strict
 * charset before touching either map. Nothing in here ever throws across the IPC
 * boundary — every function is defensive and returns a failure shape instead.
 */

type ShellKind = 'pwsh' | 'powershell' | 'cmd' | 'unix' | 'wsl' | 'ssh'

const terminals = new Map<string, pty.IPty>()
const shellKinds = new Map<string, ShellKind>()
// Remote-path/claude-path hints for SSH terminals, used by startCliInTerminal.
const sshMeta = new Map<string, { remotePath?: string; claudePath?: string }>()
// Deferred kills scheduled by a renderer effect cleanup. A StrictMode dev remount
// (mount -> cleanup -> mount) cancels its own deferred kill when create() reuses the
// still-live pty; a real close/switch has no follow-up create, so the kill fires.
const pendingKills = new Map<string, ReturnType<typeof setTimeout>>()
// Ids whose pty has already had its provider CLI auto-started, so a second
// terminalStartCli call against the same live pty (e.g. from a StrictMode remount) is a
// no-op instead of typing the launch command twice.
const launched = new Set<string>()
// Everything the pty has ever emitted, per id, capped at MAX_BUFFER_CHARS (oldest dropped).
// The renderer's xterm instance dies on unmount, so this is what a reattaching terminal
// replays to repaint its scrollback — the pty itself keeps running throughout.
const outputBuffers = new Map<string, string>()

// What each live pty was created with, so a re-create can tell "reattach to this" from
// "the chat's environment changed, respawn it" — see createTerminal.
const configs = new Map<string, string>()

/**
 * Enough about each live pty to describe it in a list, kept beside the pty itself so
 * a listing never has to reach into the renderer for the labels.
 *
 * Deliberately not the full options object: this exists to be shown, and a listing
 * that carried the environment would be a listing that leaked an account id into the
 * renderer for every terminal at once.
 */
export interface TerminalInfo {
  id: string
  cwd: string
  provider: 'claude' | 'codex' | 'gemini'
  shell: ShellKind
  wslDistro?: string
  remoteHostId?: string
  createdAt: number
}
const terminalInfo = new Map<string, TerminalInfo>()

/**
 * Every pty this process currently holds.
 *
 * Note what is NOT needed here: any notion of how many panels are watching a given
 * terminal. FRIDAY counted sockets and closing one panel killed the stream for every
 * other one — the defect PLAN.md's "count consumers, not sockets" rule comes from.
 * Argos cannot have it, because unmounting a terminal view never kills anything: a
 * pty is torn down only by an explicit Restart, deleting its chat, or app quit (see
 * the cleanup comment in ChatTerminal). Several views can show one terminal and the
 * last one to leave takes nothing with it.
 */
export function listTerminals(): TerminalInfo[] {
  const out: TerminalInfo[] = []
  for (const id of terminals.keys()) {
    const info = terminalInfo.get(id)
    if (info) out.push(info)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

// The settings baked into a pty at spawn time (env, cwd, shell). cols/rows are deliberately
// excluded: a resize is handled by terminal:resize and is never a reason to respawn.
function configSignature(opts: CreateTerminalOptions): string {
  return JSON.stringify([
    opts.cwd ?? '',
    opts.accountId ?? '',
    opts.wslDistro ?? '',
    opts.remoteHostId ?? '',
    opts.provider ?? 'claude'
  ])
}

const MAX_BUFFER_CHARS = 200_000

function appendToBuffer(id: string, data: string): void {
  const next = (outputBuffers.get(id) ?? '') + data
  outputBuffers.set(id, next.length > MAX_BUFFER_CHARS ? next.slice(next.length - MAX_BUFFER_CHARS) : next)
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id)
}

/** The buffered output replayed when a renderer reattaches to a live pty. */
export function getTerminalBuffer(id: string): string {
  if (!isSafeId(id)) return ''
  return outputBuffers.get(id) ?? ''
}

export interface CreateTerminalOptions {
  cwd?: string
  /** The account id for the chat's provider (Claude account, CODEX_HOME account, or Gemini account). */
  accountId?: string
  /** If set, run the shell inside this WSL distro (matches a WSL chat's environment). */
  wslDistro?: string
  /** If set, connect over SSH to this stored host id (matches a remote chat's environment). */
  remoteHostId?: string
  /** Which CLI this terminal is for. Defaults to 'claude'. */
  provider?: 'claude' | 'codex' | 'gemini'
  /** The chat's Claude Code session id — resumed when launching claude (local shells only). */
  resumeSessionId?: string
  cols: number
  rows: number
}

let pwshAvailable: boolean | null = null

function hasPwsh(): boolean {
  if (pwshAvailable !== null) return pwshAvailable
  try {
    const result = spawnSync('where', ['pwsh.exe'], { stdio: 'ignore' })
    pwshAvailable = result.status === 0
  } catch {
    pwshAvailable = false
  }
  return pwshAvailable
}

// Best-effort PATH lookup for a bare command, used only for a diagnostic message —
// never for deciding whether to launch (that check would race the pty's own PATH).
function hasCommand(cmd: string): boolean {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      stdio: 'ignore'
    })
    return result.status === 0
  } catch {
    return false
  }
}

function pickShell(): { shell: string; kind: ShellKind } {
  if (process.platform === 'win32') {
    if (hasPwsh()) return { shell: 'pwsh.exe', kind: 'pwsh' }
    return { shell: 'powershell.exe', kind: 'powershell' }
  }
  return { shell: process.env.SHELL || 'bash', kind: 'unix' }
}

// Recognise a WSL share path — \\wsl.localhost\<distro>\rest or \\wsl$\<distro>\rest — so a
// local chat pointed at a WSL folder still opens a terminal inside that distro (a local
// shell can't cd into a UNC path, and the session lives in WSL, not Windows).
function parseWslUnc(p?: string): { distro: string; linuxPath: string } | null {
  if (!p) return null
  const m = p.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\?(.*)$/i)
  if (!m) return null
  return { distro: m[1], linuxPath: '/' + m[2].replace(/\\/g, '/') }
}

export function createTerminal(
  id: string,
  opts: CreateTerminalOptions,
  onData: (id: string, data: string) => void,
  onExit: (id: string, exitCode: number) => void
): { ok: boolean; shell?: string; cliLaunched?: boolean; reused?: boolean; buffer?: string } {
  if (!isSafeId(id)) return { ok: false }

  const pendingKill = pendingKills.get(id)
  if (pendingKill) {
    // A pending deferred kill that gets cancelled here means the pty is being reused, so its
    // buffer must survive — only a kill that actually fires clears it.
    clearTimeout(pendingKill)
    pendingKills.delete(id)
  }
  const sig = configSignature(opts)
  const existing = terminals.get(id)
  if (existing) {
    if (configs.get(id) === sig) {
      // Benign re-create for an id that already has a live pty (StrictMode remount, a
      // redundant renderer create call, or a renderer reattaching after navigating away).
      // Reuse it rather than spawning a duplicate, and hand back the scrollback so the fresh
      // xterm instance can repaint what it missed.
      return {
        ok: true,
        shell: shellKinds.get(id),
        cliLaunched: launched.has(id),
        reused: true,
        buffer: outputBuffers.get(id) ?? ''
      }
    }
    // Same id, different environment — the chat switched account/provider/distro/host/folder.
    // The live pty has the old one baked into its env and cwd, so reattaching would silently
    // keep running under the account the user just switched away from. Replace it instead.
    killTerminal(id)
  }
  launched.delete(id)
  // Fresh spawn — any buffer left over from a previous pty on this id is stale history.
  outputBuffers.delete(id)

  try {
    const env: Record<string, string> = { ...buildSubprocessEnv() }
    // Strip Claude Code's own runtime/session env vars. Otherwise a `claude` launched in
    // this terminal inherits the GUI's agent context (CLAUDECODE, entrypoint, SSE port,
    // a stray CLAUDE_CONFIG_DIR, etc.) and behaves as a nested session. Account config dir
    // is re-set explicitly below (local shells only).
    for (const k of Object.keys(env)) {
      if (k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE') || k === 'CLAUDE_CONFIG_DIR') {
        delete env[k]
      }
    }

    const cols = Number.isInteger(opts.cols) && opts.cols > 0 ? opts.cols : 80
    const rows = Number.isInteger(opts.rows) && opts.rows > 0 ? opts.rows : 24

    let shell: string
    let shellArgs: string[] = []
    let kind: ShellKind
    let spawnCwd: string

    // Resolve the effective WSL target: an explicit WSL chat, or a folder that is a WSL
    // share (\\wsl.localhost\<distro>\..). The share form also gives us the Linux path.
    const fromUnc = process.platform === 'win32' ? parseWslUnc(opts.cwd) : null
    const wslDistro = opts.wslDistro || fromUnc?.distro
    const wslCwd = fromUnc
      ? fromUnc.linuxPath
      : opts.cwd && opts.cwd.startsWith('/')
        ? opts.cwd
        : undefined

    if (opts.remoteHostId) {
      // Remote SSH → hand off to the system ssh CLI with the stored host's connection
      // details. Windows/WSL env (CLAUDE_CONFIG_DIR, CLAUDE_BIN, provider account env) is
      // meaningless on the remote box, so leave it unset; the remote's own PATH/login
      // resolves the CLI.
      const ssh = getSshTerminalCommand(opts.remoteHostId)
      if (!ssh) return { ok: false }
      shell = ssh.shell
      shellArgs = ssh.args
      kind = 'ssh'
      spawnCwd = os.homedir()
      sshMeta.set(id, { remotePath: ssh.remotePath, claudePath: ssh.claudePath })
    } else if (wslDistro && process.platform === 'win32') {
      // WSL → run inside that distro so it uses the distro's own claude, login, and session.
      // Windows CLAUDE_CONFIG_DIR/CLAUDE_BIN are meaningless in WSL, so leave them unset.
      shell = 'wsl.exe'
      shellArgs = ['-d', wslDistro]
      if (wslCwd) shellArgs.push('--cd', wslCwd)
      kind = 'wsl'
      spawnCwd = os.homedir()
    } else {
      const picked = pickShell()
      shell = picked.shell
      kind = picked.kind
      spawnCwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir()
      const provider = opts.provider ?? 'claude'
      if (provider === 'claude') {
        const configDir = accountConfigDir(opts.accountId)
        if (configDir) {
          env.CLAUDE_CONFIG_DIR = configDir
          delete env.ANTHROPIC_API_KEY
        }
        env.CLAUDE_BIN = resolveClaudeBin()
      } else {
        Object.assign(env, providerAccountEnv(provider, opts.accountId))
      }

      // Local shell → run the provider CLI directly as the pty's own process, via the
      // shell's non-interactive mode, instead of spawning an interactive shell and typing
      // the launch command into it afterwards. Non-interactive mode prints no banner (no
      // "Windows PowerShell / Copyright…") and no command echo, so the very first pty
      // output is the CLI itself — nothing for the loading overlay to have to hide.
      const resumeId = safeResumeId(opts.resumeSessionId) || ''
      const cliCmd = buildCliInvocation(kind, provider, resumeId, id)
      if (cliCmd) {
        if (kind === 'pwsh' || kind === 'powershell') {
          shellArgs = ['-NoLogo', '-NoProfile', '-Command', cliCmd]
        } else if (kind === 'cmd') {
          shell = 'cmd.exe'
          shellArgs = ['/d', '/q', '/c', cliCmd]
        } else {
          shellArgs = ['-c', cliCmd]
        }
        // The CLI is launched as part of this very spawn — a subsequent startCliInTerminal
        // call for this id (e.g. a stray renderer call, or a StrictMode remount) is a no-op.
        launched.add(id)
      }
    }

    const cliLaunched = launched.has(id)

    const p = pty.spawn(shell, shellArgs, {
      name: 'xterm-color',
      cols,
      rows,
      cwd: spawnCwd,
      env
    })

    p.onData((d) => {
      // A superseded pty (replaced above because the environment changed) can still flush a
      // final chunk as it dies. Dropping it keeps the replacement's buffer and screen clean.
      if (terminals.get(id) !== p) return
      appendToBuffer(id, d)
      onData(id, d)
    })
    p.onExit((e) => {
      // Exit arrives asynchronously, so a pty we replaced can report its death *after* its
      // replacement is already registered under the same id. Cleaning up here would then wipe
      // the live pty's state and tell the renderer the new terminal had exited, so only the
      // pty currently registered for this id is allowed to.
      if (terminals.get(id) !== p) return
      onExit(id, e.exitCode)
      terminals.delete(id)
      shellKinds.delete(id)
      sshMeta.delete(id)
      launched.delete(id)
      outputBuffers.delete(id)
      configs.delete(id)
      const t = pendingKills.get(id)
      if (t) {
        clearTimeout(t)
        pendingKills.delete(id)
      }
    })

    terminals.set(id, p)
    shellKinds.set(id, kind)
    configs.set(id, sig)
    terminalInfo.set(id, {
      id,
      cwd: opts.cwd ?? '',
      provider: opts.provider ?? 'claude',
      shell: kind,
      wslDistro: opts.wslDistro,
      remoteHostId: opts.remoteHostId,
      createdAt: Date.now()
    })

    return { ok: true, shell: kind, cliLaunched }
  } catch {
    return { ok: false }
  }
}

export function writeTerminal(id: string, data: string): void {
  if (!isSafeId(id)) return
  if (typeof data !== 'string') return
  const p = terminals.get(id)
  if (!p) return
  try {
    p.write(data)
  } catch {
    // no-op
  }
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  if (!isSafeId(id)) return
  if (!Number.isInteger(cols) || cols <= 0) return
  if (!Number.isInteger(rows) || rows <= 0) return
  const p = terminals.get(id)
  if (!p) return
  try {
    p.resize(cols, rows)
  } catch {
    // no-op
  }
}

export function killTerminal(id: string): { ok: boolean } {
  if (!isSafeId(id)) return { ok: false }
  const t = pendingKills.get(id)
  if (t) {
    clearTimeout(t)
    pendingKills.delete(id)
  }
  launched.delete(id)
  // The terminal is genuinely going away (this also covers the deferred kill, which fires
  // through here), so its replay history goes with it.
  outputBuffers.delete(id)
  configs.delete(id)
  const p = terminals.get(id)
  if (!p) return { ok: false }
  try {
    p.kill()
  } catch {
    // no-op
  }
  terminals.delete(id)
  shellKinds.delete(id)
  sshMeta.delete(id)
  terminalInfo.delete(id)
  return { ok: true }
}

// Schedule a kill instead of running it immediately, so a renderer effect cleanup that's
// about to be immediately followed by a re-create for the same id (React StrictMode's
// dev-only mount -> cleanup -> mount) doesn't tear down a pty that's about to be reused.
// A real close/session-switch has no follow-up create, so the kill fires after the delay.
export function killTerminalDeferred(id: string): void {
  if (!isSafeId(id)) return
  if (pendingKills.has(id)) return
  const t = setTimeout(() => {
    pendingKills.delete(id)
    killTerminal(id)
  }, 250)
  pendingKills.set(id, t)
}

// Only characters found in Claude Code session ids (UUID-like) — guards against injecting
// anything into the shell command line.
function safeResumeId(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(v) ? v : null
}

// Quote a single token for inclusion in a PowerShell command line: wrap in single
// quotes, doubling any embedded single quote (PowerShell's own escaping rule).
function quotePwsh(token: string): string {
  return `'${token.replace(/'/g, "''")}'`
}

// Quote a single token for inclusion in a cmd.exe command line.
function quoteCmd(token: string): string {
  return `"${token}"`
}

// Quote a single token for inclusion in a POSIX shell command line.
function quoteUnix(token: string): string {
  return `'${token.replace(/'/g, `'\\''`)}'`
}

// Build the command line to run the provider CLI directly as the pty's own process (local
// shell kinds only — pwsh/powershell/cmd/unix). Unlike claudeLaunchCommand below, there's no
// interactive shell session to clear first: the shell never gets to print a banner or echo a
// command, because it's invoked non-interactively (-Command / /c / -c) purely to exec the CLI.
// Returns null for a kind this isn't meant for (wsl/ssh use the interactive startCliInTerminal
// path instead).
function buildCliInvocation(
  kind: ShellKind,
  provider: 'claude' | 'codex' | 'gemini',
  resumeId: string,
  id: string
): string | null {
  if (kind !== 'pwsh' && kind !== 'powershell' && kind !== 'cmd' && kind !== 'unix') return null

  if (provider === 'claude') {
    if (kind === 'pwsh' || kind === 'powershell') {
      return resumeId
        ? `& $env:CLAUDE_BIN --resume ${resumeId}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN }`
        : `& $env:CLAUDE_BIN`
    }
    if (kind === 'cmd') {
      return resumeId ? `"%CLAUDE_BIN%" --resume ${resumeId} || "%CLAUDE_BIN%"` : `"%CLAUDE_BIN%"`
    }
    return resumeId ? `"$CLAUDE_BIN" --resume ${resumeId} || "$CLAUDE_BIN"` : `"$CLAUDE_BIN"`
  }

  if (provider === 'gemini') {
    // Gemini chats open Antigravity (Google's latest agentic CLI) instead of the older
    // `gemini` CLI. Its launch command is `agy` — a bare command resolved from the shell's
    // own PATH (including a Windows .cmd shim), so no node-entry resolution is needed.
    return 'agy'
  }

  // codex
  const { command, prefixArgs } = resolveCodex()
  // A bare `codex` (no resolved node entry) depends on it being on this process's PATH —
  // silently unlike the npm-entry path. We can't inject a diagnostic into the CLI's own
  // stdout with a direct spawn (there's no interactive shell to type into first), so just
  // proceed: the shell itself will print its own "not recognized"/"command not found" error,
  // which is visible and good enough. `id` is unused here but kept for signature symmetry
  // with the interactive path (sshMeta-style per-terminal lookups would key off it).
  void id
  if (kind === 'pwsh' || kind === 'powershell') {
    return `& ${[command, ...prefixArgs].map(quotePwsh).join(' ')}`
  }
  if (kind === 'cmd') {
    return [command, ...prefixArgs].map(quoteCmd).join(' ')
  }
  return [command, ...prefixArgs].map(quoteUnix).join(' ')
}

// Build the shell-specific command line that launches claude, clearing the shell's
// screen first (so the shell banner and the echoed launch command never show through the
// loading overlay) and, when resuming a session, chaining a no-resume fallback at the
// shell level: `claude --resume <id>` exits non-zero on a missing/incompatible session, so
// `|| claude` (or the shell's equivalent) relaunches fresh immediately, all before the
// overlay is ever lifted. Shared by the initial launch in startCliInTerminal below.
function claudeLaunchCommand(kind: ShellKind, id: string, resumeId: string): string {
  if (kind === 'pwsh' || kind === 'powershell') {
    return resumeId
      ? `Clear-Host; & $env:CLAUDE_BIN --resume ${resumeId}; if ($LASTEXITCODE -ne 0) { & $env:CLAUDE_BIN }\r`
      : `Clear-Host; & $env:CLAUDE_BIN\r`
  }
  if (kind === 'cmd') {
    return resumeId
      ? `cls & "%CLAUDE_BIN%" --resume ${resumeId} || "%CLAUDE_BIN%"\r`
      : `cls & "%CLAUDE_BIN%"\r`
  }
  if (kind === 'wsl') {
    return resumeId ? `clear; claude --resume ${resumeId} || claude\n` : `clear; claude\n`
  }
  if (kind === 'ssh') {
    // Remote box has no CLAUDE_BIN — use the host's configured claude path (or bare
    // `claude` on its PATH), from the working directory the host was set up for.
    const meta = sshMeta.get(id)
    const bin = meta?.claudePath || 'claude'
    const cd = meta?.remotePath ? `cd ${quoteUnix(meta.remotePath)} && ` : ''
    if (!resumeId) return `clear; ${cd}${bin}\n`
    // Wrap the resume-or-fallback pair in parens so it runs as a single unit after the
    // one-time cd, rather than re-prefixing cd onto the fallback too.
    return cd
      ? `clear; ${cd}( ${bin} --resume ${resumeId} || ${bin} )\n`
      : `clear; ${bin} --resume ${resumeId} || ${bin}\n`
  }
  return resumeId
    ? `clear; "$CLAUDE_BIN" --resume ${resumeId} || "$CLAUDE_BIN"\n`
    : `clear; "$CLAUDE_BIN"\n`
}

export function startCliInTerminal(
  id: string,
  provider: 'claude' | 'codex' | 'gemini',
  resumeSessionId?: string
): { ok: boolean } {
  if (!isSafeId(id)) return { ok: false }
  const p = terminals.get(id)
  const kind = shellKinds.get(id)
  if (!p || !kind) return { ok: false }
  if (launched.has(id)) return { ok: true }
  launched.add(id)
  try {
    if (provider === 'claude') {
      // Resume the chat's own Claude Code session when we have its id, else start fresh.
      // The resume-or-fallback logic lives entirely in the shell command line now (see
      // claudeLaunchCommand) — no need to watch the pty's output from here.
      const resume = safeResumeId(resumeSessionId) || ''
      p.write(claudeLaunchCommand(kind, id, resume))
      return { ok: true }
    }

    // Codex/Gemini launch fresh — no resume support in these CLIs' interactive mode.

    // Gemini chats open Antigravity (Google's latest agentic CLI) instead of the older
    // `gemini` CLI. Its launch command is `agy` — a bare command resolved from PATH by
    // the interactive shell (including a Windows .cmd shim), so no node-entry resolution
    // is needed.
    // Clear the shell screen before typing any launch command below, so the shell banner
    // (and the echoed command itself) never shows through the loading overlay — same
    // reasoning as claudeLaunchCommand's Clear-Host/cls/clear prefix.
    const clear =
      kind === 'pwsh' || kind === 'powershell' ? 'Clear-Host; ' : kind === 'cmd' ? 'cls & ' : 'clear; '

    if (provider === 'gemini') {
      p.write(`${clear}agy${kind === 'pwsh' || kind === 'powershell' || kind === 'cmd' ? '\r' : '\n'}`)
      return { ok: true }
    }

    if (kind === 'wsl' || kind === 'ssh') {
      // Use the distro's/remote's own CLI on PATH — the Windows node-entry resolution
      // doesn't apply there. WSL/SSH chats are Claude-only in practice; handled defensively.
      p.write(`${clear}${provider}\n`)
      return { ok: true }
    }

    const { command, prefixArgs } = resolveCodex()
    // A bare `codex` (no resolved node entry) depends on it being on this process's PATH —
    // silently unlike the npm-entry path, so check and say so instead of a bare shell.
    if (command === 'codex' && prefixArgs.length === 0 && !hasCommand('codex')) {
      p.write(`\r\n\x1b[33mcodex not found on PATH — install with: npm i -g @openai/codex\x1b[0m\r\n`)
    }
    if (kind === 'pwsh' || kind === 'powershell') {
      p.write(`${clear}& ${[command, ...prefixArgs].map(quotePwsh).join(' ')}\r`)
    } else if (kind === 'cmd') {
      p.write(`${clear}${[command, ...prefixArgs].map(quoteCmd).join(' ')}\r`)
    } else {
      p.write(`${clear}${[command, ...prefixArgs].map(quoteUnix).join(' ')}\n`)
    }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

export function killAllTerminals(): void {
  for (const t of pendingKills.values()) clearTimeout(t)
  pendingKills.clear()
  launched.clear()
  outputBuffers.clear()
  configs.clear()
  for (const [id, p] of terminals) {
    try {
      p.kill()
    } catch {
      // no-op
    }
    terminals.delete(id)
    shellKinds.delete(id)
    sshMeta.delete(id)
  }
}
