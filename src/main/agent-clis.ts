import { execFile, spawn } from 'child_process'
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
 * `account/read` over the `codex app-server` JSON-RPC protocol: the only way
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
