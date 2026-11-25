import { execFile } from 'child_process'
import {
  KEYCHAIN_ACCOUNT,
  claudeKeychainService,
  decodeKeychainOutput,
  joinChunks,
  looksLikeCredentials,
  parseChunkManifest
} from './claude-keychain-pure'

/**
 * macOS: read Claude Code's OAuth credentials JSON from the login Keychain, for the
 * plan-usage bars. Reading another app's item makes macOS ask the user to allow it
 * ("Always Allow" stops the prompts until Claude Code rewrites the item), so reads are
 * rare: only when a usage fetch is about to hit the network, cached, deduplicated, and
 * with a long cooldown after a refusal. The secret is never logged.
 */

// Long enough for the user to answer the "allow access" dialog.
const SECURITY_TIMEOUT_MS = 60_000
const ERR_NOT_FOUND = 44 // errSecItemNotFound
const NOT_FOUND_RETRY_MS = 5 * 60_000
const FAILURE_RETRY_MS = 6 * 60 * 60_000
const REFRESH_MIN_MS = 10 * 60_000

type Lookup = { ok: true; value: string } | { ok: false; notFound: boolean }

function findPassword(service: string, account?: string): Promise<Lookup> {
  const args = ['find-generic-password', '-s', service]
  if (account) args.push('-a', account)
  args.push('-w')
  return new Promise((resolve) => {
    try {
      execFile(
        '/usr/bin/security',
        args,
        { timeout: SECURITY_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            resolve({ ok: false, notFound: (err as { code?: unknown }).code === ERR_NOT_FOUND })
            return
          }
          resolve({ ok: true, value: decodeKeychainOutput(String(stdout)) })
        }
      )
    } catch {
      resolve({ ok: false, notFound: false })
    }
  })
}

/** One full read: the plain item, then the chunked form, then any account (older CLIs). */
async function readService(service: string): Promise<{ value: string | null; notFound: boolean }> {
  const plain = await findPassword(service, KEYCHAIN_ACCOUNT)
  if (plain.ok) return { value: looksLikeCredentials(plain.value) ? plain.value : null, notFound: false }
  if (!plain.notFound) return { value: null, notFound: false }

  const manifestRaw = await findPassword(service, `${KEYCHAIN_ACCOUNT}#m`)
  if (manifestRaw.ok) {
    const manifest = parseChunkManifest(manifestRaw.value)
    if (!manifest) return { value: null, notFound: false }
    const parts: string[] = []
    for (let i = 0; i < manifest.n; i++) {
      const part = await findPassword(service, `${KEYCHAIN_ACCOUNT}#${i}`)
      if (!part.ok) return { value: null, notFound: false }
      parts.push(part.value)
    }
    const joined = joinChunks(parts, manifest)
    return { value: joined && looksLikeCredentials(joined) ? joined : null, notFound: false }
  }
  if (!manifestRaw.notFound) return { value: null, notFound: false }

  // Older Claude Code versions stored the item under the macOS user name.
  const any = await findPassword(service)
  if (any.ok) return { value: looksLikeCredentials(any.value) ? any.value : null, notFound: false }
  return { value: null, notFound: any.notFound }
}

interface Entry {
  value: string | null
  readAt: number
  retryAt: number
}

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<string | null>>()

/**
 * The credentials JSON Claude Code stored for `configDir` (null = the default ~/.claude),
 * or null. Cached: `refresh` re-reads a cached value (e.g. its token expired, Claude Code
 * may have rotated it), but at most every 10 minutes. Never rejects; null off macOS.
 */
export function readClaudeKeychainCredentials(
  configDir: string | null,
  opts: { refresh?: boolean } = {}
): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  const service = claudeKeychainService(configDir || null)
  const now = Date.now()
  const hit = cache.get(service)
  if (hit) {
    if (hit.value !== null && !(opts.refresh && now - hit.readAt >= REFRESH_MIN_MS)) {
      return Promise.resolve(hit.value)
    }
    if (hit.value === null && now < hit.retryAt) return Promise.resolve(null)
  }
  const pending = inflight.get(service)
  if (pending) return pending
  const p = readService(service)
    .then(({ value, notFound }) => {
      const at = Date.now()
      if (value !== null) {
        cache.set(service, { value, readAt: at, retryAt: 0 })
        return value
      }
      // Keep a previously good value over a failed refresh; the caller sees it's expired.
      const prev = cache.get(service)
      const retryAt = at + (notFound ? NOT_FOUND_RETRY_MS : FAILURE_RETRY_MS)
      if (prev?.value) {
        cache.set(service, { ...prev, readAt: at })
        return prev.value
      }
      cache.set(service, { value: null, readAt: at, retryAt })
      return null
    })
    .catch(() => null)
    .finally(() => inflight.delete(service))
  inflight.set(service, p)
  return p
}
