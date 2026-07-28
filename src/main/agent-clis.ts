import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { resolveCodex, resolveGemini } from './providers/cli-resolve'
import { JsonRpcConnection } from './providers/jsonrpc'

/**
 * Login-status detection + login-trigger for the Codex and Gemini CLIs, mirroring
 * `accounts.ts`'s pattern for Claude Code — but deliberately NOT that file's
 * multi-account model. Each CLI here has exactly one login (the machine's own),
 * matching how the app already treats Claude's *default* account.
 */

export type AgentCliId = 'codex' | 'gemini'

export interface AgentCliStatus {
  id: AgentCliId
  /** The binary resolves on PATH at all. */
  installed: boolean
  loggedIn: boolean
  /** Human-readable detail — install/login instructions when not ready. */
  detail?: string
  email?: string
  plan?: string
}

/**
 * Resolves through `cli-resolve.ts` and spawns without a shell — see that
 * file's comment for why `shell: true` isn't safe/reliable here even with
 * fixed, non-user-controlled args like these.
 */
function execCli(
  id: AgentCliId,
  args: string[],
  timeoutMs: number,
  envOverride?: Record<string, string>
): Promise<{ code: number; output: string }> {
  const { command, prefixArgs } = id === 'codex' ? resolveCodex() : resolveGemini()
  return new Promise((resolve) => {
    execFile(
      command,
      [...prefixArgs, ...args],
      { timeout: timeoutMs, windowsHide: true, env: envOverride ? { ...process.env, ...envOverride } : process.env },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          resolve({ code: -1, output })
          return
        }
        // A non-zero exit still yields useful stdout/stderr (e.g. "not logged in").
        resolve({ code: err ? 1 : 0, output })
      }
    )
  })
}

/**
 * `account/read` over the app-server JSON-RPC protocol (see providers/
 * codex-app-server.ts for the full protocol writeup) — this is the only way
 * to get the logged-in email/plan; `codex login status` only says yes/no.
 * Reads cached local identity, so it works even with an expired token
 * (verified live: returned a real email/plan while this exact login's
 * refresh token was broken elsewhere in the app).
 */
async function readCodexAccount(codexHome?: string): Promise<{ email?: string; plan?: string } | null> {
  return new Promise((resolve) => {
    const { command, prefixArgs } = resolveCodex()
    const child = spawn(command, [...prefixArgs, 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: codexHome ? { ...process.env, CODEX_HOME: codexHome } : process.env
    })
    const rpc = new JsonRpcConnection(child)
    const timer = setTimeout(() => {
      rpc.dispose('account lookup timed out')
      child.kill()
      resolve(null)
    }, 5000)
    const finish = (result: { email?: string; plan?: string } | null) => {
      clearTimeout(timer)
      rpc.dispose('account lookup done')
      child.kill()
      resolve(result)
    }
    child.on('error', () => finish(null))
    ;(async () => {
      try {
        await rpc.request('initialize', { clientInfo: { name: 'argos', title: 'argos', version: '1' } })
        const res = (await rpc.request('account/read', {})) as {
          account?: { type?: string; email?: string | null; planType?: string } | null
        }
        if (res.account?.type === 'chatgpt') {
          const plan = res.account.planType
          finish({
            email: res.account.email ?? undefined,
            plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined
          })
        } else {
          finish(null)
        }
      } catch {
        finish(null)
      }
    })()
  })
}

/** `codex login status` is a fast, purely local check — no network call needed.
 *  `codexHome`, when set, checks a specific account's isolated CODEX_HOME instead
 *  of the machine default (see provider-accounts.ts). */
export async function checkCodexStatus(codexHome?: string): Promise<AgentCliStatus> {
  const { code, output } = await execCli(
    'codex',
    ['login', 'status'],
    8000,
    codexHome ? { CODEX_HOME: codexHome } : undefined
  )
  if (code === -1) {
    return {
      id: 'codex',
      installed: false,
      loggedIn: false,
      detail: 'Codex CLI not found. Install with: npm install -g @openai/codex'
    }
  }
  const loggedIn = /logged in/i.test(output)
  const account = loggedIn ? await readCodexAccount(codexHome) : null
  return {
    id: 'codex',
    installed: true,
    loggedIn,
    detail: loggedIn ? undefined : 'Not signed in. Run `codex login` in a terminal.',
    email: account?.email,
    plan: account?.plan
  }
}

/**
 * Gemini CLI has no equivalent one-shot "status" command, so this checks for a
 * configured auth method in `~/.gemini/settings.json` — a local file check, not a
 * live API call (avoids spending quota just to check login state). The exact
 * settings schema is best-effort/unconfirmed against a primary source; treat a
 * missing or unrecognized file as "not logged in" rather than guessing.
 *
 * There is no per-account variant: Gemini runs through Antigravity, whose login is
 * machine-wide and lives in the OS keyring rather than under a config dir, so there
 * is only ever one Gemini identity to check (see provider-accounts.ts).
 */
export async function checkGeminiStatus(): Promise<AgentCliStatus> {
  const { code } = await execCli('gemini', ['--version'], 8000)
  if (code === -1) {
    return {
      id: 'gemini',
      installed: false,
      loggedIn: false,
      detail: 'Gemini CLI not found. Install with: npm install -g @google/gemini-cli'
    }
  }
  const base = os.homedir()
  const settingsPath = path.join(base, '.gemini', 'settings.json')
  let loggedIn = false
  try {
    const raw = fs.readFileSync(settingsPath, 'utf-8')
    const parsed = JSON.parse(raw)
    loggedIn = !!parsed?.security?.auth?.selectedAuthType
  } catch {
    loggedIn = false
  }
  // `google_accounts.json`'s "active" field is the signed-in email — same
  // local-file-read approach accounts.ts uses for Claude's oauthAccount, no
  // network call. Only meaningful for the oauth-personal auth path; an
  // API-key login has no associated email here.
  let email: string | undefined
  if (loggedIn) {
    try {
      const raw = fs.readFileSync(path.join(base, '.gemini', 'google_accounts.json'), 'utf-8')
      const parsed = JSON.parse(raw)
      email = typeof parsed?.active === 'string' ? parsed.active : undefined
    } catch {
      email = undefined
    }
  }
  return {
    id: 'gemini',
    installed: true,
    loggedIn,
    detail: loggedIn ? undefined : 'Not signed in. Run `gemini` in a terminal and choose "Login with Google".',
    email
  }
}

export function checkAgentCliStatus(id: AgentCliId): Promise<AgentCliStatus> {
  return id === 'codex' ? checkCodexStatus() : checkGeminiStatus()
}

/**
 * Launch an interactive login for a CLI in its own terminal window, mirroring
 * `accounts.ts`'s `loginAccount()`. The user completes the browser OAuth flow
 * themselves; this only opens the terminal and runs the CLI's own login entry
 * point (interactive `gemini` for the auth-method picker; `codex login` for Codex).
 */
export function loginAgentCli(id: AgentCliId): { launched: boolean; command: string } {
  const command = id === 'codex' ? 'codex login' : 'gemini'
  try {
    let child: ReturnType<typeof spawn> | null = null
    if (process.platform === 'win32') {
      const bat = path.join(os.tmpdir(), `${id}-login-${Date.now()}.bat`)
      fs.writeFileSync(bat, `@echo off\r\n${command}\r\n`)
      child = spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', bat], {
        detached: true,
        stdio: 'ignore'
      })
    } else if (process.platform === 'darwin') {
      child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${command}"`], {
        detached: true,
        stdio: 'ignore'
      })
    } else {
      child = spawn('x-terminal-emulator', ['-e', `bash -lc "${command}; exec bash"`], {
        detached: true,
        stdio: 'ignore'
      })
    }
    child?.on('error', () => {
      /* swallow — caller falls back to showing the command */
    })
    child?.unref()
    return { launched: true, command }
  } catch {
    return { launched: false, command }
  }
}
