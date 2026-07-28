import { spawn } from 'child_process'
import { resolveCodex } from './providers/cli-resolve'
import { getProviderAccounts } from './provider-accounts'

// Codex plan-usage badge — the Codex analog of plan-usage.ts's Claude fetch, but
// sourced from `codex app-server` (JSON-RPC 2.0 over stdio) instead of an HTTP
// endpoint, since Codex has no equivalent unauthenticated-token REST call.
//
// Protocol (ground-truthed against the installed CLI): send `initialize`, then
// the `initialized` notification, then `account/rateLimits/read`; the server
// replies to id 2 with `{ result: { rateLimits: { primary, secondary, planType } } }`.
// Like plan-usage.ts, every failure degrades to `null`/`{}` — this is an ambient
// badge, never worth throwing into the caller over.

export interface CodexAccountUsage {
  /** 0–100, from rateLimits.primary.usedPercent. */
  utilization: number
  /** ISO 8601 timestamp, converted from primary.resetsAt (UNIX seconds), if reported. */
  resetsAt?: string
  windowMinutes?: number
  planType?: string
}

const CACHE_TTL_MS = 5 * 60_000
// The app-server should reply in well under this, but it's a fresh process spawn
// per account (not the persistent one interactive chat keeps alive), so give it
// room before giving up and killing it.
const RPC_TIMEOUT_MS = 10_000

let cache: { at: number; data: Record<string, CodexAccountUsage> } | null = null

/**
 * Spawn one `codex app-server`, drive it through initialize → initialized →
 * account/rateLimits/read, and resolve with just the primary window's usage.
 * Never throws — every failure path (spawn error, malformed output, timeout)
 * resolves `null` instead, and the child is always killed before returning.
 */
async function readCodexRateLimits(configDir: string | null): Promise<CodexAccountUsage | null> {
  try {
    const { command, prefixArgs } = resolveCodex()
    const child = spawn(command, [...prefixArgs, 'app-server'], {
      env: { ...process.env, ...(configDir ? { CODEX_HOME: configDir } : {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    })
    // A dead/misbehaving child must never crash the caller — swallow and let the
    // timeout (or stdout never producing id:2) resolve null instead.
    child.on('error', () => {})

    return await new Promise<CodexAccountUsage | null>((resolve) => {
      let settled = false
      let buf = ''

      const finish = (result: CodexAccountUsage | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        // The app-server is long-lived by design — it must never be left running
        // once we have (or give up on) an answer.
        try {
          child.kill()
        } catch {
          /* already gone */
        }
        resolve(result)
      }

      const timer = setTimeout(() => finish(null), RPC_TIMEOUT_MS)

      child.stdout?.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let nl: number
        // eslint-disable-next-line no-cond-assign
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let msg: Record<string, unknown>
          try {
            msg = JSON.parse(line)
          } catch {
            continue // not JSON (or a partial line split oddly) — ignore and keep reading
          }
          if (msg.id !== 2) continue
          if (msg.error) {
            finish(null)
            return
          }
          const result = msg.result as { rateLimits?: Record<string, unknown> } | undefined
          const primary = result?.rateLimits?.primary as
            | { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }
            | undefined
          const planType = result?.rateLimits?.planType
          if (!primary || typeof primary.usedPercent !== 'number') {
            finish(null)
            return
          }
          finish({
            utilization: primary.usedPercent,
            resetsAt: typeof primary.resetsAt === 'number' ? new Date(primary.resetsAt * 1000).toISOString() : undefined,
            windowMinutes: typeof primary.windowDurationMins === 'number' ? primary.windowDurationMins : undefined,
            planType: typeof planType === 'string' ? planType : undefined
          })
          return
        }
      })

      child.on('exit', () => finish(null))

      try {
        child.stdin?.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { clientInfo: { name: 'argos', title: 'Argos', version: '0.6.0' } }
          }) + '\n'
        )
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
        child.stdin?.write(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n'
        )
      } catch {
        finish(null)
      }
    })
  } catch {
    return null
  }
}

/**
 * Usage for every Codex account, keyed by account id. Fetches run SEQUENTIALLY —
 * each spawns its own `codex app-server`, so parallel fetches would mean N
 * simultaneous processes for N accounts, which is unnecessary load for an
 * ambient badge. Cached for CACHE_TTL_MS; pass `force` to bypass the cache.
 */
export async function getCodexAccountsUsage(force = false): Promise<Record<string, CodexAccountUsage>> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  const data: Record<string, CodexAccountUsage> = {}
  for (const account of getProviderAccounts('codex')) {
    const usage = await readCodexRateLimits(account.configDir)
    if (usage) data[account.id] = usage
  }

  cache = { at: Date.now(), data }
  return data
}
