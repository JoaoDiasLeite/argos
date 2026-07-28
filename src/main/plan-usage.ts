import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { Notification } from 'electron'
import { listConfigDirs, listAccountStatus } from './accounts'
import { getWslCredentialsPaths } from './wsl'
import { updateTrayTooltip } from './tray'
import { readJsonFile } from './json-file'

// Real plan usage straight from Anthropic, the way community HUDs (claude-hud,
// claudeline, ccusage-style statuslines) do it: GET api.anthropic.com/api/oauth/usage
// with the Claude Code OAuth token from ~/.claude/.credentials.json. UNDOCUMENTED
// endpoint — it can change without notice, so parsing is deliberately tolerant and
// every failure degrades to a status the UI can explain instead of an exception.
//
// This module fetches PER ACCOUNT: every managed Claude login (plus each WSL distro
// with its own login) has its own token, its own numbers, and — critically — its own
// cache / backoff / lockout state. The endpoint rate-limits aggressively and escalates
// to ~1h lockouts if hammered or called with expired tokens, so each credential source
// is isolated: one account being locked out or expired never forces a network call for
// another, and fetches run sequentially with a small gap between real network calls.

export interface PlanWindow {
  key: string
  label: string
  /** 0–100 (the endpoint reports percentages). */
  utilization: number
  /** ISO 8601 timestamp when this window resets, if reported. */
  resetsAt?: string
}

export type PlanStatus = 'ok' | 'no-credentials' | 'unauthorized' | 'rate-limited' | 'error'

export interface AccountPlanUsage {
  /** Stable identity key: 'acct:<email>' when the login's identity is known,
   *  else 'path:<credentials path>'. One entry per ACCOUNT, not per environment. */
  accountKey: string
  /** Display name: the managed account's name, else the email local-part / env. */
  accountName: string
  email?: string
  /** Environments this login is present in (e.g. ['Local', 'Ubuntu-DevOps']). */
  envs?: string[]
  /** True when this identity includes the machine-default login. */
  isDefault?: boolean
  /** Managed account ids (accounts.ts `CCAccount.id`) sharing this identity — the
   *  same ids sessions store as `Session.accountId`, so the renderer can match a
   *  chat's account to its usage entry. */
  accountIds?: string[]
  status: PlanStatus
  error?: string
  /** True when `windows` is carried over from an older successful fetch. */
  stale?: boolean
  subscriptionType?: string
  rateLimitTier?: string
  fetchedAt: number
  windows: PlanWindow[]
}

export interface PlanUsageReport {
  accounts: AccountPlanUsage[]
  /** accountKey of the entry ambient UI should feature: the default account if it has
   *  windows, else the first entry with windows. */
  primary?: string
  generatedAt: number
}

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const CACHE_TTL_MS = 5 * 60_000
// Failed lookups retry sooner than the happy path, but never hammer the endpoint —
// it 429s readily.
const ERROR_TTL_MS = 90_000
// How long a previous good result stays worth showing alongside an error.
const STALE_OK_MS = 30 * 60_000
// Spacing between actual network calls when polling multiple accounts in sequence —
// the endpoint rate-limits aggressively, so we never fire two real requests back to back.
const NETWORK_GAP_MS = 300

// Known window spellings across endpoint revisions / community reports.
const WINDOW_SHAPES: { key: string; label: string; alts: string[] }[] = [
  { key: 'five_hour', label: 'Session (5h)', alts: ['five_hour', 'current', 'session'] },
  { key: 'seven_day', label: 'Week · all models', alts: ['seven_day', 'weekly'] },
  { key: 'seven_day_opus', label: 'Week · Opus', alts: ['seven_day_opus'] },
  { key: 'seven_day_sonnet', label: 'Week · Sonnet', alts: ['seven_day_sonnet'] }
]

interface OauthCreds {
  accessToken: string
  expiresAt?: number
  subscriptionType?: string
  rateLimitTier?: string
}

// Per-account polling state: each credential source keeps its own cache, last-good
// snapshot, and 429 lockout independently so one account can never trip another's backoff.
interface AccountState {
  cache: AccountPlanUsage | null
  lastGood: AccountPlanUsage | null
  // When the endpoint said 429 with a Retry-After, don't touch it again before this.
  retryAt: number
}

const states = new Map<string, AccountState>()

function stateFor(key: string): AccountState {
  let s = states.get(key)
  if (!s) {
    s = { cache: null, lastGood: null, retryAt: 0 }
    states.set(key, s)
  }
  return s
}

// One ACCOUNT (identity) to poll, possibly logged in from several environments.
// `credsPaths` are its candidate credential files, best-first (local before WSL) —
// the fetch uses whichever holds the freshest non-expired token, since any valid
// token of the same account reports the same server-side limits.
interface Source {
  accountKey: string
  accountName: string
  email?: string
  envs: string[]
  isDefault: boolean
  accountIds: string[]
  credsPaths: string[]
}

function readCredentialsFile(credsPath: string): OauthCreds | null {
  try {
    if (!fs.existsSync(credsPath)) return null
    const raw = readJsonFile<Record<string, unknown>>(credsPath)
    const o = (raw.claudeAiOauth ?? raw) as Record<string, unknown>
    if (typeof o?.accessToken !== 'string' || !o.accessToken) return null
    return {
      accessToken: o.accessToken,
      expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : undefined,
      subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
      rateLimitTier: typeof o.rateLimitTier === 'string' ? o.rateLimitTier : undefined
    }
  } catch {
    return null
  }
}

/** Read the login identity (email) from a .claude.json sitting next to a config dir. */
function readIdentityEmail(claudeJsonPath: string): string | undefined {
  try {
    const raw = readJsonFile<{
      oauthAccount?: { emailAddress?: string }
    }>(claudeJsonPath)
    const email = raw.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : undefined
  } catch {
    return undefined
  }
}

// A credential file found in some environment, before identity grouping.
interface Candidate {
  env: string
  credsPath: string
  claudeJsonPath: string
  /** Managed-account display name, when this candidate comes from accounts.ts. */
  name?: string
  /** Managed account id (accounts.ts `CCAccount.id`), when this candidate comes from accounts.ts. */
  accountId?: string
  emailHint?: string
  isDefault?: boolean
  /** Lower = preferred within an identity group (local logins before WSL copies). */
  priority: number
}

/**
 * Enumerate ACCOUNTS to poll. Every credential file (managed accounts, the machine
 * default, WSL distros) is a candidate; candidates are grouped by login IDENTITY —
 * the email in the neighbouring .claude.json — because the same account logged in
 * from several environments (e.g. Work on Local AND a WSL distro) has different
 * tokens but identical server-side limits. One fetch per account, not per env.
 */
async function enumerateSources(): Promise<Source[]> {
  const candidates: Candidate[] = []

  const { accounts } = listAccountStatus()
  for (const acc of accounts) {
    const dir = acc.configDir
    candidates.push({
      env: 'Local',
      credsPath: dir
        ? path.join(dir, '.credentials.json')
        : path.join(os.homedir(), '.claude', '.credentials.json'),
      claudeJsonPath: dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'),
      name: acc.name,
      accountId: acc.id,
      emailHint: acc.email,
      isDefault: acc.isDefault,
      priority: 0
    })
  }

  // Safety net: any config dir known to accounts.ts not covered above.
  for (const dir of listConfigDirs()) {
    candidates.push({
      env: 'Local',
      credsPath: dir
        ? path.join(dir, '.credentials.json')
        : path.join(os.homedir(), '.claude', '.credentials.json'),
      claudeJsonPath: dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json'),
      priority: 1
    })
  }

  // WSL distros — best-effort; skipped silently when unreachable.
  try {
    for (const w of await getWslCredentialsPaths()) {
      // <home>/.claude/.credentials.json → <home>/.claude.json
      const home = path.dirname(path.dirname(w.credentialsPath))
      candidates.push({
        env: w.distro,
        credsPath: w.credentialsPath,
        claudeJsonPath: path.join(home, '.claude.json'),
        priority: 2
      })
    }
  } catch {
    // WSL unavailable — local accounts only.
  }

  // Dedupe by credentials file, then group by identity. Identity key preference:
  // email (same account anywhere) → access token (same login copied around) → path.
  const seenPaths = new Set<string>()
  const groups = new Map<string, Candidate[]>()
  for (const c of candidates.sort((a, b) => a.priority - b.priority)) {
    const norm = c.credsPath.toLowerCase()
    if (seenPaths.has(norm)) continue
    seenPaths.add(norm)
    const email = c.emailHint ?? readIdentityEmail(c.claudeJsonPath)
    if (email) c.emailHint = email
    const token = email ? undefined : readCredentialsFile(c.credsPath)?.accessToken
    const key = email ? `acct:${email.toLowerCase()}` : token ? `tok:${token.slice(0, 24)}` : `path:${norm}`
    const g = groups.get(key)
    if (g) g.push(c)
    else groups.set(key, [c])
  }

  const sources: Source[] = []
  for (const [key, group] of groups) {
    const email = group.find((c) => c.emailHint)?.emailHint
    const named = group.find((c) => c.name)
    sources.push({
      accountKey: email ? `acct:${email.toLowerCase()}` : key,
      accountName: named?.name ?? (email ? email.split('@')[0] : group[0].env),
      email,
      envs: [...new Set(group.map((c) => c.env))],
      isDefault: group.some((c) => c.isDefault),
      accountIds: [...new Set(group.map((c) => c.accountId).filter((id): id is string => !!id))],
      credsPaths: group.map((c) => c.credsPath)
    })
  }
  return sources
}

// On failure, surface the last good windows (if recent) as stale data with the failure
// status attached, so the UI can show bars + a hint instead of nothing. Mirrors the
// original single-account failure() helper, but scoped to one account's state.
function failure(
  src: Source,
  st: AccountState,
  partial: { status: PlanStatus; error?: string; subscriptionType?: string; rateLimitTier?: string }
): AccountPlanUsage {
  const carryOver = st.lastGood && Date.now() - st.lastGood.fetchedAt < STALE_OK_MS
  const result: AccountPlanUsage = {
    accountKey: src.accountKey,
    accountName: src.accountName,
    email: src.email,
    envs: src.envs,
    isDefault: src.isDefault,
    accountIds: src.accountIds,
    status: partial.status,
    error: partial.error,
    fetchedAt: Date.now(),
    windows: carryOver ? st.lastGood!.windows : [],
    stale: carryOver || undefined,
    subscriptionType: partial.subscriptionType ?? st.lastGood?.subscriptionType,
    rateLimitTier: partial.rateLimitTier ?? st.lastGood?.rateLimitTier
  }
  st.cache = result
  return result
}

function extractWindows(body: Record<string, unknown>): PlanWindow[] {
  // Some revisions nest the windows under rate_limits; accept both.
  const src = (body.rate_limits && typeof body.rate_limits === 'object'
    ? body.rate_limits
    : body) as Record<string, unknown>
  const windows: PlanWindow[] = []
  for (const shape of WINDOW_SHAPES) {
    for (const alt of shape.alts) {
      const v = src[alt]
      if (!v || typeof v !== 'object') continue
      const rec = v as Record<string, unknown>
      const u = rec.utilization
      if (typeof u !== 'number' || !isFinite(u)) continue
      windows.push({
        key: shape.key,
        label: shape.label,
        utilization: Math.max(0, Math.min(100, u)),
        resetsAt: typeof rec.resets_at === 'string' ? rec.resets_at : undefined
      })
      break
    }
  }
  return windows
}

// Fetch one account. Returns { entry, hitNetwork }: hitNetwork distinguishes an actual
// HTTP request (which must be spaced out) from a cached/expired/backing-off short-circuit.
async function fetchAccount(
  src: Source,
  force: boolean
): Promise<{ entry: AccountPlanUsage; hitNetwork: boolean }> {
  const st = stateFor(src.accountKey)

  if (st.cache) {
    const age = Date.now() - st.cache.fetchedAt
    // Backoff wins even over a forced refresh — the endpoint 429s readily (and
    // escalates: repeated bad calls earn multi-minute Retry-After lockouts).
    if (st.cache.status === 'rate-limited' && Date.now() < st.retryAt)
      return { entry: st.cache, hitNetwork: false }
    if (st.cache.status !== 'ok' && age < ERROR_TTL_MS) return { entry: st.cache, hitNetwork: false }
    if (st.cache.status === 'ok' && !force && age < CACHE_TTL_MS)
      return { entry: st.cache, hitNetwork: false }
  }

  // Any valid token of this account works — pick the freshest non-expired one across
  // its environments (60s skew: a token about to lapse mid-request counts as expired).
  const cutoff = Date.now() + 60_000
  const all = src.credsPaths
    .map(readCredentialsFile)
    .filter((c): c is OauthCreds => !!c)
  if (all.length === 0) return { entry: failure(src, st, { status: 'no-credentials' }), hitNetwork: false }
  const freshest = (arr: OauthCreds[]) =>
    [...arr].sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0]
  const valid = all.filter((c) => !c.expiresAt || c.expiresAt > cutoff)
  const creds = valid.length > 0 ? freshest(valid) : freshest(all)
  const expired = valid.length === 0
  if (expired) {
    // Never spend a request on a token we can already see is dead — repeated
    // expired-token calls are what trigger the edge-level 429 lockout.
    return {
      entry: failure(src, st, {
        status: 'unauthorized',
        subscriptionType: creds.subscriptionType,
        rateLimitTier: creds.rateLimitTier
      }),
      hitNetwork: false
    }
  }

  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'argos'
      }
    })
    if (res.status === 401 || res.status === 403) {
      // Token rejected despite a future expiry — Claude Code rotates it on its next run;
      // nothing to do here. Deliberately NOT refreshing with the refresh token: rotating
      // it out from under Claude Code could invalidate the CLI's session.
      return {
        entry: failure(src, st, {
          status: 'unauthorized',
          subscriptionType: creds.subscriptionType,
          rateLimitTier: creds.rateLimitTier
        }),
        hitNetwork: true
      }
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      st.retryAt =
        Date.now() + Math.min(isFinite(ra) && ra > 0 ? ra * 1000 : ERROR_TTL_MS, 3600_000)
      return { entry: failure(src, st, { status: 'rate-limited', error: 'HTTP 429' }), hitNetwork: true }
    }
    if (!res.ok) {
      return { entry: failure(src, st, { status: 'error', error: `HTTP ${res.status}` }), hitNetwork: true }
    }
    const body = (await res.json()) as Record<string, unknown>
    const entry: AccountPlanUsage = {
      accountKey: src.accountKey,
      accountName: src.accountName,
      email: src.email,
      envs: src.envs,
      isDefault: src.isDefault,
      accountIds: src.accountIds,
      status: 'ok',
      fetchedAt: Date.now(),
      windows: extractWindows(body),
      subscriptionType: creds.subscriptionType,
      rateLimitTier: creds.rateLimitTier
    }
    st.cache = st.lastGood = entry
    return { entry, hitNetwork: true }
  } catch (err) {
    return {
      entry: failure(src, st, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      }),
      hitNetwork: true
    }
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Pick the accountKey the ambient UI (tray, notifications) should feature: the account
 *  holding the machine-default login if it has windows, else the first with windows. */
function pickPrimary(accounts: AccountPlanUsage[]): string | undefined {
  const def = accounts.find((a) => a.isDefault && a.windows.length > 0)
  if (def) return def.accountKey
  const first = accounts.find((a) => a.windows.length > 0)
  return first?.accountKey
}

export async function getPlanUsage(force = false): Promise<PlanUsageReport> {
  const sources = await enumerateSources()
  const accounts: AccountPlanUsage[] = []
  // Sequential — the endpoint rate-limits aggressively. Only actual network calls get
  // the inter-request gap; cached / expired / backing-off entries are free.
  let firstNetworkDone = false
  for (const src of sources) {
    if (firstNetworkDone) await sleep(NETWORK_GAP_MS)
    const { entry, hitNetwork } = await fetchAccount(src, force)
    if (hitNetwork) firstNetworkDone = true
    accounts.push(entry)
  }
  const report: PlanUsageReport = {
    accounts,
    primary: pickPrimary(accounts),
    generatedAt: Date.now()
  }
  return report
}

// ─── Watcher: periodic refresh + tray tooltip + threshold notifications ─────────

// Threshold-crossing latches, keyed by `${accountKey}:${windowKey}:${threshold}`. A latch
// prevents re-notifying for a threshold already reported; it re-arms when utilization drops
// below (threshold − 5) or the window's resetsAt changes (a new window period began).
interface Latch {
  armed: boolean
  resetsAt?: string
}
const latches = new Map<string, Latch>()
const THRESHOLDS = [85, 95]
const NOTIFY_WINDOW_KEYS = new Set(['five_hour', 'seven_day'])

function windowLabelForTooltip(key: string): string {
  return key === 'five_hour' ? 'Session' : 'Week'
}

function buildTooltip(report: PlanUsageReport): string {
  const primary = report.primary && report.accounts.find((a) => a.accountKey === report.primary)
  if (!primary || primary.windows.length === 0) return 'Argos'
  const parts: string[] = []
  const five = primary.windows.find((w) => w.key === 'five_hour')
  const seven = primary.windows.find((w) => w.key === 'seven_day')
  if (five) parts.push(`Session ${five.utilization.toFixed(0)}%`)
  if (seven) parts.push(`Week ${seven.utilization.toFixed(0)}%`)
  if (parts.length === 0) return 'Argos'
  return `Argos — ${parts.join(' · ')}`
}

// "resets in 1h 20m" for a notification body — plain and terse.
function fmtResetShort(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
  const mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'resets soon'
  if (mins < 60) return `resets in ${mins}m`
  return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
}

function checkThresholds(report: PlanUsageReport, showMain: () => void): void {
  if (!Notification.isSupported()) return
  for (const acc of report.accounts) {
    // Only fresh, real numbers drive notifications — never stale carry-over.
    if (acc.status !== 'ok' || acc.stale) continue
    for (const w of acc.windows) {
      if (!NOTIFY_WINDOW_KEYS.has(w.key)) continue
      for (const threshold of THRESHOLDS) {
        const latchKey = `${acc.accountKey}:${w.key}:${threshold}`
        const latch = latches.get(latchKey) ?? { armed: true, resetsAt: w.resetsAt }
        // Re-arm if the window rolled over (new reset time) or dropped back below the
        // threshold's hysteresis band — so a fresh climb can notify again.
        if (latch.resetsAt !== w.resetsAt || w.utilization < threshold - 5) {
          latch.armed = true
          latch.resetsAt = w.resetsAt
        }
        if (latch.armed && w.utilization >= threshold) {
          latch.armed = false
          latch.resetsAt = w.resetsAt
          const reset = fmtResetShort(w.resetsAt)
          const body =
            `${windowLabelForTooltip(w.key)} window ${w.utilization.toFixed(0)}% used` +
            (reset ? ` · ${reset}` : '')
          try {
            const n = new Notification({ title: `Plan limit warning — ${acc.accountName}`, body })
            n.on('click', () => showMain())
            n.show()
          } catch {
            // Notifications are best-effort — never let one throw into the watcher.
          }
        }
        latches.set(latchKey, latch)
      }
    }
  }
}

export interface PlanUsageWatcherHandlers {
  broadcast: (report: PlanUsageReport) => void
  showMain: () => void
}

let watcherHandlers: PlanUsageWatcherHandlers | null = null

// The shared post-fetch path: everything that should happen after ANY fetch (the initial
// watcher fetch, the interval, or an IPC-triggered getPlanUsage) runs through here so the
// tray tooltip, broadcast, and threshold notifications stay consistent.
function afterFetch(report: PlanUsageReport): void {
  if (!watcherHandlers) return
  try {
    updateTrayTooltip(buildTooltip(report))
  } catch {
    /* tray may not exist */
  }
  try {
    watcherHandlers.broadcast(report)
  } catch {
    /* renderer may be loading */
  }
  checkThresholds(report, watcherHandlers.showMain)
}

/** Run a fetch and push the result through the shared post-fetch path. */
async function refreshAndDispatch(force: boolean): Promise<PlanUsageReport> {
  const report = await getPlanUsage(force)
  afterFetch(report)
  return report
}

let watcherStarted = false

export function startPlanUsageWatcher(handlers: PlanUsageWatcherHandlers): void {
  if (watcherStarted) return
  watcherStarted = true
  watcherHandlers = handlers

  // Initial fetch ~30s after start (let the app settle; don't hammer the endpoint on
  // launch), then every 10 minutes.
  setTimeout(() => {
    void refreshAndDispatch(false)
    setInterval(() => void refreshAndDispatch(false), 10 * 60_000)
  }, 30_000)
}

/** IPC entry point. Fetches and — once the watcher is running — pushes the result through
 *  the same tray/broadcast/notification path as the scheduled fetches. */
export async function getPlanUsageForIpc(force = false): Promise<PlanUsageReport> {
  if (watcherHandlers) return refreshAndDispatch(force)
  return getPlanUsage(force)
}
