import { execFile, spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import {
  handleStreamLine,
  makeLineBuffer,
  StreamState,
  StreamEmit
} from './claude-stream'
import { getHiddenDistros } from './store'
import { parseHistoryLines } from './sftp-pure'

export interface WslDistro {
  name: string
  isDefault: boolean
  /** The distro's VM is up right now — the STATE column of `wsl -l -v`. Mirrors the
   *  renderer-side type in src/renderer/src/types.ts. */
  running: boolean
}

const isWindows = process.platform === 'win32'

/** Enumerate installed WSL distros. `wsl --list --verbose` output is UTF-16LE on Windows. */
export function listDistros(): Promise<WslDistro[]> {
  if (!isWindows) return Promise.resolve([])
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['--list', '--verbose'],
      { encoding: 'buffer', windowsHide: true },
      (err, stdoutBuf) => {
        if (err && !stdoutBuf?.length) return resolve([])
        // Output is UTF-16LE. Decode it (keeping real spaces, which separate the
        // NAME / STATE / VERSION columns) and parse the name from each data row.
        const text = Buffer.from(stdoutBuf).toString('utf16le')
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        const distros: WslDistro[] = []
        // First line is the header (NAME STATE VERSION). Default distro is marked with '*'.
        for (let i = 1; i < lines.length; i++) {
          const raw = lines[i]
          const isDefault = raw.startsWith('*')
          const withoutStar = isDefault ? raw.slice(1).trim() : raw
          const [name, state] = withoutStar.split(/\s+/)
          // STATE comes free with `--verbose`; RemoteView shows it as a live dot. Note it
          // means "the VM is up right now", NOT "reachable" — a Stopped distro is perfectly
          // usable, WSL just boots it on connect, so don't render it as an error.
          if (name) distros.push({ name, isDefault, running: state === 'Running' })
        }
        resolve(distros)
      }
    )
  })
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Run `claude`/`node` through an INTERACTIVE login shell. Per-user version managers (nvm,
// asdf, fnm) typically only initialize in interactive shells — Ubuntu's ~/.bashrc returns
// early for non-interactive ones — so a plain `bash -lc` would miss an nvm-provided node and
// fall back to a stale system node. Stdout shell-init noise is ignored by the stream parser
// (non-JSON lines are skipped); job-control warnings on stderr only surface on non-zero exit.
const CLAUDE_SHELL_FLAG = '-lic'

/**
 * The Windows user-profile mounted into WSL (/mnt/c/Users/…, /c/Users/…). A WSL chat
 * defaulting here is almost always the cwd-inheritance artifact, never an intentional
 * working dir — redirect those to the distro's $HOME. (Other /mnt paths are left alone.)
 */
function isWindowsHomeMount(p: string): boolean {
  return /^\/mnt\/[a-z]\/Users\//i.test(p) || /^\/[a-z]\/Users\//i.test(p)
}

const SKIP_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

/**
 * Resolve a distro's $HOME (starts the distro; times out fast if unreachable).
 *
 * Deliberately does NOT use a login shell (`bash -lc`) to read the variable. A login
 * shell sources the user's init files (~/.profile, ~/.bashrc), and on at least one real
 * distro that init runs `sudo` to start background services (postgres/redis) plus prints
 * assorted startup noise. With no tty attached, `sudo` blocks on a password prompt that
 * never resolves, so the probe hangs/fails, `wslHome` returns null, and the caller drops
 * the ENTIRE distro (its projects/sessions vanish, or its credentials path is skipped).
 * `printenv` is coreutils (always present) and runs with no shell at all — no rc files,
 * no sudo, no noise — so this stays fast and reliable regardless of what a given distro's
 * shell init does.
 */
function wslHome(distro: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'printenv', 'HOME'],
      { encoding: 'utf8', windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err) return resolve(null)
        // printenv emits just the value, but stay defensive in case anything precedes it
        // (e.g. distro-level MOTD written to stdout) — take the first absolute-path line.
        const home = (stdout || '')
          .trim()
          .split('\n')
          .map((l) => l.trim())
          .find((l) => l.startsWith('/'))
        resolve(home ?? null)
      }
    )
  })
}

export interface WslClaudeRoot {
  distro: string
  projectsDir: string
  claudeJsonPath: string
}

export interface WslCredentialsPath {
  distro: string
  /** Windows-side UNC path to the distro's ~/.claude/.credentials.json. */
  credentialsPath: string
}

/**
 * For every reachable WSL distro, resolve the Windows-side UNC path to its
 * ~/.claude/.credentials.json — so plan-usage can read a distro's Claude Code
 * OAuth token with plain fs, the same way getWslClaudeRoots reads its projects.
 * Distros without a credentials file are skipped silently.
 */
export async function getWslCredentialsPaths(): Promise<WslCredentialsPath[]> {
  if (!isWindows) return []
  const distros = await listDistros()
  const hidden = new Set(getHiddenDistros())
  const out: WslCredentialsPath[] = []
  for (const d of distros) {
    if (SKIP_DISTROS.has(d.name) || hidden.has(d.name)) continue
    const home = await wslHome(d.name)
    if (!home) continue
    const unc = `\\\\wsl.localhost\\${d.name}${home.replace(/\//g, '\\')}`
    const credentialsPath = `${unc}\\.claude\\.credentials.json`
    try {
      if (fs.existsSync(credentialsPath)) out.push({ distro: d.name, credentialsPath })
    } catch {
      // not reachable — skip
    }
  }
  return out
}

/**
 * For every reachable WSL distro that has Claude Code data, return Windows-side UNC paths
 * to its ~/.claude so the existing fs-based parsing can read it directly.
 */
export async function getWslClaudeRoots(): Promise<WslClaudeRoot[]> {
  if (!isWindows) return []
  const distros = await listDistros()
  const hidden = new Set(getHiddenDistros())
  const roots: WslClaudeRoot[] = []
  for (const d of distros) {
    if (SKIP_DISTROS.has(d.name) || hidden.has(d.name)) continue
    const home = await wslHome(d.name)
    if (!home) continue
    const unc = `\\\\wsl.localhost\\${d.name}${home.replace(/\//g, '\\')}`
    const projectsDir = `${unc}\\.claude\\projects`
    try {
      if (fs.existsSync(projectsDir)) {
        roots.push({ distro: d.name, projectsDir, claudeJsonPath: `${unc}\\.claude.json` })
      }
    } catch {
      // not reachable — skip
    }
  }
  return roots
}

function buildCommand(
  claudePath: string,
  model: string | undefined,
  resume: string | undefined,
  cwd: string | undefined
): string {
  const flags = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits']
  if (model) flags.push('--model', model)
  if (resume) flags.push('--resume', resume)
  // A folder chosen for a WSL chat comes back from the native picker as a Windows share
  // path (\\wsl.localhost\<distro>\…); translate it to the distro's Linux path before cd.
  const linuxCwd = uncToWslPath(cwd) ?? cwd
  // wsl.exe inherits the caller's Windows cwd (e.g. /mnt/c/Users/…). Default to the
  // distro's own $HOME so chats run inside the Linux filesystem, not the Windows mount —
  // and redirect any inherited Windows-home path to $HOME too.
  const useHome = !linuxCwd || isWindowsHomeMount(linuxCwd)
  const cd = useHome ? 'cd "$HOME" && ' : `cd ${shQuote(linuxCwd)} && `
  return `${cd}${claudePath || 'claude'} ${flags.join(' ')}`
}

/** Claude Code requires a modern Node; older majors can't even parse the CLI bundle. */
const MIN_NODE_MAJOR = 18

/**
 * Does this distro start and run a command? Nothing more. This is what the Remote & WSL
 * list's status dot reflects, so it deliberately does NOT probe Node or Claude Code — a
 * distro can be perfectly usable without them, and conflating the two meant the dot
 * answered the wrong question. Use testDistroClaude for that.
 *
 * A cold distro has to boot first, hence the same generous timeout as the Claude probe.
 */
export function testDistro(distro: string): Promise<{ ok: boolean; message: string }> {
  if (!isWindows) return Promise.resolve({ ok: false, message: 'WSL is only available on Windows' })
  return new Promise((resolve) => {
    const startedAt = Date.now()
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'sh', '-c', 'printf "%s@%s" "$(whoami)" "$(hostname)"'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        const who = (stdout || '').trim()
        if (who) {
          return resolve({ ok: true, message: `Started as ${who} in ${Date.now() - startedAt} ms` })
        }
        resolve({
          ok: false,
          message: (stderr || '').trim() || (err ? err.message : 'Distro did not respond')
        })
      }
    )
  })
}

/**
 * Probes Node and Claude Code inside the distro — the "is Claude Code actually installed and
 * runnable over there" check, which is a separate question from whether the distro starts
 * (see testDistro).
 */
export function testDistroClaude(distro: string): Promise<{ ok: boolean; message: string }> {
  if (!isWindows) return Promise.resolve({ ok: false, message: 'WSL is only available on Windows' })
  return new Promise((resolve) => {
    // Probe Node and Claude together so we can blame an old/missing Node for a CLI that
    // won't start, rather than surfacing a raw SyntaxError stack trace.
    const probe = 'node -v 2>/dev/null || echo __NONODE__; echo __CLAUDE__; claude --version 2>&1 | head -5'
    execFile(
      'wsl.exe',
      ['-d', distro, '--', 'bash', CLAUDE_SHELL_FLAG, probe],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
      (err, stdout, stderr) => {
        const [nodePartRaw, claudePartRaw = ''] = (stdout || '').split('__CLAUDE__')
        const nodeOut = (nodePartRaw || '').trim()
        const claudeOut = claudePartRaw.trim()
        const nodeMissing = !nodeOut || nodeOut.includes('__NONODE__')
        const nodeMajorMatch = nodeOut.match(/v(\d+)\./)
        const nodeMajor = nodeMajorMatch ? parseInt(nodeMajorMatch[1], 10) : null

        const firstLine = claudeOut.split('\n')[0] ?? ''
        const looksLikeVersion = /\d+\.\d+\.\d+/.test(firstLine)
        // The signature of a too-old Node failing to parse the modern CLI bundle.
        const looksBroken = /SyntaxError|Unexpected token|cli\.js|node:module|ERR_[A-Z_]+/.test(claudeOut)

        if (looksLikeVersion && !looksBroken) {
          // `claude` works. Only note the Node version when the probe's `node` is itself
          // modern — under a version manager that node may be the stale system one while
          // claude actually runs on a newer node, so a "Node v12" note would mislead.
          const suffix = nodeMajor !== null && nodeMajor >= MIN_NODE_MAJOR ? ` · Node ${nodeOut}` : ''
          return resolve({ ok: true, message: `${firstLine}${suffix}` })
        }

        if (nodeMissing) {
          return resolve({
            ok: false,
            message: 'Node.js not found in this distro. Install Node 18+ and Claude Code (npm i -g @anthropic-ai/claude-code).'
          })
        }
        if (nodeMajor !== null && nodeMajor < MIN_NODE_MAJOR) {
          return resolve({
            ok: false,
            message: `Node ${nodeOut} is too old — Claude Code needs Node ${MIN_NODE_MAJOR}+. Upgrade Node in this distro, then reinstall: npm i -g @anthropic-ai/claude-code`
          })
        }
        if (looksBroken) {
          return resolve({
            ok: false,
            message: `Claude Code failed to start${!nodeMissing ? ` (Node ${nodeOut})` : ''}. This usually means Node is too old — Claude Code needs Node ${MIN_NODE_MAJOR}+.`
          })
        }
        const notFound = !claudeOut || /not found|no such file|command not found/i.test(claudeOut)
        if (notFound) {
          return resolve({
            ok: false,
            message: 'claude not found in this distro. Install it: npm i -g @anthropic-ai/claude-code'
          })
        }
        resolve({
          ok: false,
          message: claudeOut.slice(0, 300) || (stderr || '').trim() || (err ? err.message : 'claude not found in this distro')
        })
      }
    )
  })
}

const activeProcs = new Map<string, ChildProcess>()

export interface WslRunHandlers extends StreamEmit {
  onError: (msg: string) => void
}

export function runWsl(
  appSessionId: string,
  distro: string,
  prompt: string,
  model: string | undefined,
  claudeSessionId: string | undefined,
  cwd: string | undefined,
  claudePath: string | undefined,
  h: WslRunHandlers
): void {
  if (!isWindows) {
    h.onError('WSL is only available on Windows')
    return
  }
  // The folder picker hands back a \\wsl.localhost\<distro>\… UNC path; translate it to the
  // distro's Linux path so `cd` inside bash resolves it.
  const cmd = buildCommand(claudePath || 'claude', model, claudeSessionId, uncToWslPath(cwd) ?? cwd)
  const child = spawn('wsl.exe', ['-d', distro, '--', 'bash', CLAUDE_SHELL_FLAG, cmd], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  activeProcs.set(appSessionId, child)

  const state: StreamState = { sessionId: claudeSessionId }
  const lines = makeLineBuffer((line) => handleStreamLine(line, appSessionId, state, h))
  let stderr = ''

  child.stdout?.on('data', (d: Buffer) => lines.push(d.toString('utf8')))
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
  child.on('error', (e) => {
    h.onError(e.message)
    activeProcs.delete(appSessionId)
  })
  child.on('close', (code) => {
    lines.flush()
    if (code && code !== 0 && stderr.trim()) h.onError(stderr.trim().slice(0, 500))
    activeProcs.delete(appSessionId)
  })

  // Send the prompt over stdin and close it so `claude -p` runs once and exits.
  child.stdin?.end(prompt)
}

/**
 * Run a one-shot headless `claude -p` inside a distro and capture its full output — used
 * for background JSON tasks (e.g. the GitLab-MCP backlog backfill) where the MCP server
 * only exists inside WSL. Loads the distro's own MCP config automatically; bypasses
 * permission prompts (there's no interactive channel) and restricts tools to allowedTools.
 * Returns the concatenated assistant text (or the final result string).
 */
export function runWslOneShot(
  distro: string,
  prompt: string,
  opts: { model?: string; allowedTools?: string[]; cwd?: string; timeoutMs?: number }
): Promise<{ ok: boolean; text: string; error?: string }> {
  if (!isWindows) return Promise.resolve({ ok: false, text: '', error: 'WSL is only available on Windows' })
  return new Promise((resolve) => {
    const flags = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions']
    if (opts.model) flags.push('--model', opts.model)
    if (opts.allowedTools?.length) flags.push('--allowedTools', opts.allowedTools.join(','))
    const useHome = !opts.cwd || isWindowsHomeMount(opts.cwd)
    const cd = useHome ? 'cd "$HOME" && ' : `cd ${shQuote(opts.cwd!)} && `
    const cmd = `${cd}claude ${flags.join(' ')}`
    const child = spawn('wsl.exe', ['-d', distro, '--', 'bash', CLAUDE_SHELL_FLAG, cmd], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let stderr = ''
    let done = false
    const finish = (r: { ok: boolean; text: string; error?: string }) => {
      if (done) return
      done = true
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, text: '', error: `Timed out after ${(opts.timeoutMs ?? 120000) / 1000}s` })
    }, opts.timeoutMs ?? 120000)

    child.stdout?.on('data', (d: Buffer) => (out += d.toString('utf8')))
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, text: '', error: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      // Parse the stream-json lines: accumulate assistant text; honour the final result.
      let text = ''
      let resultErr: string | undefined
      for (const line of out.split('\n')) {
        const t = line.trim()
        if (!t.startsWith('{')) continue
        try {
          const msg = JSON.parse(t)
          if (msg.type === 'assistant') {
            for (const b of msg.message?.content ?? []) if (b.type === 'text') text += b.text
          } else if (msg.type === 'result') {
            if (msg.subtype && msg.subtype !== 'success') resultErr = msg.result ?? msg.subtype
            else if (typeof msg.result === 'string' && !text.trim()) text = msg.result
          }
        } catch {
          /* non-JSON shell noise — skip */
        }
      }
      if (resultErr) return finish({ ok: false, text, error: resultErr })
      if (code && code !== 0 && !text.trim()) {
        return finish({ ok: false, text: '', error: stderr.trim().slice(0, 500) || `claude exited with code ${code}` })
      }
      finish({ ok: true, text })
    })

    child.stdin?.end(prompt)
  })
}

const HISTORY_FILES = ['.bash_history', '.zsh_history']

/**
 * Read a WSL distro's shell history for the "Connect" session view — the WSL analog of
 * sftpHistory in sftp.ts. Resolves $HOME first (wslHome, which deliberately avoids a login
 * shell — see its own comment), then `cat`s the history file directly via an argv array
 * (no shell string built from user input). Reuses parseHistoryLines (sftp-pure.ts) to parse.
 */
export async function wslHistory(distro: string): Promise<{ ok: boolean; commands?: string[]; error?: string }> {
  if (!isWindows) return { ok: false, error: 'WSL is only available on Windows' }
  const home = await wslHome(distro)
  if (!home) return { ok: false, error: 'Could not resolve home directory' }

  for (const name of HISTORY_FILES) {
    const filePath = `${home}/${name}`
    const raw = await new Promise<string | null>((resolve) => {
      execFile(
        'wsl.exe',
        ['-d', distro, '--', 'cat', filePath],
        { encoding: 'utf8', windowsHide: true, timeout: 8000 },
        (err, stdout) => resolve(err ? null : stdout)
      )
    })
    if (raw !== null) return { ok: true, commands: parseHistoryLines(raw) }
  }
  return { ok: true, commands: [] }
}

/** Convert a \\wsl.localhost\<distro>\home\… (or \\wsl$\…) UNC path to its Linux path. */
export function uncToWslPath(p: string | undefined): string | null {
  if (!p) return null
  const m = p.match(/^\\\\wsl(?:\.localhost|\$)\\[^\\]+\\(.*)$/i)
  if (!m) return null
  return '/' + m[1].replace(/\\/g, '/')
}

export function stopWsl(appSessionId: string): boolean {
  const child = activeProcs.get(appSessionId)
  if (child) {
    child.kill()
    activeProcs.delete(appSessionId)
    return true
  }
  return false
}
