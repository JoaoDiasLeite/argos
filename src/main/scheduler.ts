import { app, Notification } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { scheduledWorkingDirectory, startupRunTime } from './scheduler-safety'
import { buildSubprocessEnv } from './auth'
import { accountConfigDir } from './accounts'
import { readJsonFile } from './json-file'
import { resolvePolicy } from './ai-policy'
import { providerFor } from './config'
import { getEngine } from './providers/registry'
import { collectText } from './providers/collect'
import { mcpServersForProject } from './mcp'

// ─── Data model ────────────────────────────────────────────────────────────

export interface ScheduledRunCadence {
  kind: 'interval'
  everyMinutes: number
}

export interface DailyCadence {
  kind: 'daily'
  time: string // "HH:MM"
}

export interface WeeklyCadence {
  kind: 'weekly'
  day: number // 0=Sun..6=Sat
  time: string
}

export type Cadence = ScheduledRunCadence | DailyCadence | WeeklyCadence

export interface ScheduledRun {
  id: string
  name: string
  prompt: string
  model?: string
  projectPath?: string
  accountId?: string
  cadence: Cadence
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  lastResult?: { ok: boolean; summary: string; costUsd: number; at: number }
  nextRunAt?: number
  missedRunPolicy?: 'skip' | 'run-once'
  /**
   * Explicit tool-access intent stored on the run.
   * 'read-only' → disallowedTools list is passed at execution time (enforced by SDK).
   * 'full'      → no tool restriction.
   * Undefined (legacy) → treated as 'full' to preserve existing behavior.
   */
  toolAccess?: 'read-only' | 'full'
  /** @deprecated Use toolAccess instead. Kept for backward-compat read of old saved data. */
  allowedTools?: string[]
}

// ─── ID safety ─────────────────────────────────────────────────────────────

const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

/** Returns true only if the id contains no path separators or traversal sequences. */
function isSafeId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && SAFE_ID_RE.test(id)
}

// ─── Persistence ───────────────────────────────────────────────────────────

const schedulerDir = path.join(app.getPath('userData'), 'scheduler')

function ensureDir(): void {
  if (!fs.existsSync(schedulerDir)) fs.mkdirSync(schedulerDir, { recursive: true })
}

function fileFor(id: string): string {
  // isSafeId must be verified before calling fileFor
  return path.join(schedulerDir, `${id}.json`)
}

/** Write JSON atomically: write to a temp file then rename to avoid partial writes on crash. */
function writeJsonAtomic(filePath: string, obj: unknown): void {
  const tmp = filePath + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, filePath)
}

// ─── Cadence validation ─────────────────────────────────────────────────────

const MIN_INTERVAL_MINUTES = 1
const DEFAULT_INTERVAL_MINUTES = 60

/** Parse "HH:MM" returning { h, m } or null if invalid. */
function parseHHMM(time: string): { h: number; m: number } | null {
  if (typeof time !== 'string') return null
  const parts = time.split(':')
  if (parts.length !== 2) return null
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (!Number.isFinite(h) || h < 0 || h > 23) return null
  if (!Number.isFinite(m) || m < 0 || m > 59) return null
  return { h, m }
}

/** Sanitize and clamp a cadence so it can never cause runaway firing. */
function sanitizeCadence(cadence: Cadence): Cadence {
  if (cadence.kind === 'interval') {
    const mins = Number(cadence.everyMinutes)
    const safe = Number.isFinite(mins) && mins >= MIN_INTERVAL_MINUTES
      ? Math.floor(mins)
      : DEFAULT_INTERVAL_MINUTES
    return { kind: 'interval', everyMinutes: Math.max(MIN_INTERVAL_MINUTES, safe) }
  }
  if (cadence.kind === 'daily') {
    const parsed = parseHHMM(cadence.time)
    return { kind: 'daily', time: parsed ? cadence.time : '09:00' }
  }
  if (cadence.kind === 'weekly') {
    const parsed = parseHHMM(cadence.time)
    const day = Number(cadence.day)
    const safeDay = Number.isFinite(day) && day >= 0 && day <= 6 ? Math.floor(day) : 1
    return { kind: 'weekly', day: safeDay, time: parsed ? cadence.time : '09:00' }
  }
  // Unknown kind — default to hourly interval
  return { kind: 'interval', everyMinutes: DEFAULT_INTERVAL_MINUTES }
}

export function listScheduledRuns(): ScheduledRun[] {
  ensureDir()
  const results: ScheduledRun[] = []
  let files: string[]
  try {
    files = fs.readdirSync(schedulerDir).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  for (const f of files) {
    try {
      results.push(readJsonFile<ScheduledRun>(path.join(schedulerDir, f)))
    } catch {
      // Skip corrupt or unreadable files; log so operators can detect data issues
      console.warn(`[scheduler] Skipping unreadable routine file: ${f}`)
    }
  }
  return results.sort((a, b) => b.createdAt - a.createdAt)
}

export function upsertScheduledRun(run: ScheduledRun): ScheduledRun {
  ensureDir()

  // Validate / sanitize id — generate a safe one if missing or unsafe
  const rawId = typeof run.id === 'string' ? run.id : ''
  const safeId = isSafeId(rawId) ? rawId : Math.random().toString(36).slice(2) + Date.now().toString(36)

  // Sanitize cadence to prevent runaway firing
  const cadence = sanitizeCadence(run.cadence)

  // Trim name/prompt; disallow empty prompt
  const name = typeof run.name === 'string' ? run.name.trim() : ''
  const prompt = typeof run.prompt === 'string' ? run.prompt.trim() : ''
  if (!prompt) throw new Error('Routine prompt must not be empty')

  // Migrate legacy allowedTools field → toolAccess.
  // If toolAccess is already set, honour it; otherwise infer from the old field.
  let toolAccess: 'read-only' | 'full' = 'full'
  if (run.toolAccess === 'read-only' || run.toolAccess === 'full') {
    toolAccess = run.toolAccess
  } else if (Array.isArray(run.allowedTools)) {
    // Old preset stored an explicit list → treat as read-only intent
    toolAccess = 'read-only'
  }

  // Strip the deprecated allowedTools field from the persisted record.
  const { allowedTools: _dropped, ...rest } = run
  const sanitized: ScheduledRun = { ...rest, id: safeId, cadence, name, prompt, toolAccess, missedRunPolicy: run.missedRunPolicy === 'run-once' ? 'run-once' : 'skip' }
  writeJsonAtomic(fileFor(safeId), sanitized)
  return sanitized
}

export function deleteScheduledRun(id: string): ScheduledRun[] {
  if (!isSafeId(id)) return listScheduledRuns()
  const p = fileFor(id)
  if (fs.existsSync(p)) fs.unlinkSync(p)
  return listScheduledRuns()
}

export function setScheduledRunEnabled(id: string, enabled: boolean): ScheduledRun[] {
  if (!isSafeId(id)) return listScheduledRuns()
  const p = fileFor(id)
  if (!fs.existsSync(p)) return listScheduledRuns()
  try {
    const run = readJsonFile<ScheduledRun>(p)
    const updated: ScheduledRun = { ...run, enabled }
    if (enabled) {
      updated.nextRunAt = computeNextRun(updated, Date.now())
    }
    writeJsonAtomic(p, updated)
  } catch {
    // best-effort
  }
  return listScheduledRuns()
}

// ─── Next-run computation ───────────────────────────────────────────────────

export function computeNextRun(run: ScheduledRun, fromTime: number): number {
  const cadence = sanitizeCadence(run.cadence)

  if (cadence.kind === 'interval') {
    return fromTime + cadence.everyMinutes * 60 * 1000
  }

  // Parse HH:MM — sanitizeCadence guarantees it's valid here
  const parsed = parseHHMM(cadence.time) ?? { h: 9, m: 0 }
  const { h: targetH, m: targetM } = parsed

  if (cadence.kind === 'daily') {
    const d = new Date(fromTime)
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate(), targetH, targetM, 0, 0)
    // If today's time has already passed, schedule for tomorrow
    if (candidate.getTime() <= fromTime) {
      candidate.setDate(candidate.getDate() + 1)
    }
    return candidate.getTime()
  }

  if (cadence.kind === 'weekly') {
    const d = new Date(fromTime)
    const targetDay = cadence.day // 0=Sun, already validated (0-6)
    let daysAhead = targetDay - d.getDay()
    if (daysAhead < 0) daysAhead += 7
    const candidate = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysAhead, targetH, targetM, 0, 0)
    if (candidate.getTime() <= fromTime) {
      candidate.setDate(candidate.getDate() + 7)
    }
    return candidate.getTime()
  }

  // Fallback (unreachable after sanitizeCadence)
  return fromTime + 60 * 60 * 1000
}

// ─── Headless execution ────────────────────────────────────────────────────

const MAX_SUMMARY = 4000

// Abort a headless run after 30 minutes to prevent it running forever
const HEADLESS_TIMEOUT_MS = 30 * 60 * 1000

async function executeHeadless(run: ScheduledRun): Promise<{ ok: boolean; summary: string; costUsd: number }> {
  const cwd = scheduledWorkingDirectory(run.projectPath)

  const env = buildSubprocessEnv()
  const configDir = accountConfigDir(run.accountId)
  if (configDir) {
    env.CLAUDE_CONFIG_DIR = configDir
    delete env.ANTHROPIC_API_KEY
  }

  let summary = ''
  let costUsd = 0
  let ok = true

  const abort = new AbortController()
  const timeoutHandle = setTimeout(() => abort.abort(), HEADLESS_TIMEOUT_MS)

  // Determine effective toolAccess: migrate legacy allowedTools field for runs
  // loaded from disk that were saved before the toolAccess field existed.
  const effectiveAccess: 'read-only' | 'full' =
    run.toolAccess === 'read-only'
      ? 'read-only'
      : Array.isArray(run.allowedTools)
        ? 'read-only'  // legacy: any explicit allowedTools list → treat as read-only intent
        : 'full'

  const policy = resolvePolicy({
    profile: effectiveAccess === 'read-only' ? 'routine-readonly' : 'routine-full',
    requestedModel: run.model
  })

  // Claude gets MCP servers for free via settingSources' own project-file discovery;
  // Codex/Gemini have no equivalent, so pass the same project's servers explicitly —
  // harmless no-op for Claude, the only way Codex/Gemini routines see MCP tools at all.
  const mcpServers = mcpServersForProject(run.projectPath)

  try {
    const stream = getEngine(providerFor(policy.model)).run({
      prompt: run.prompt,
      ...policy,
      cwd,
      env,
      abortController: abort,
      // Non-interactive: bypass all permission prompts.
      // For read-only routines, disallowedTools (from the policy) removes mutating
      // tools from context entirely — they cannot be invoked even under bypassPermissions.
      permissionMode: 'bypassPermissions',
      includePartialMessages: false,
      ...(Object.keys(mcpServers).length ? { mcpServers } : {})
    })

    const collected = await collectText(stream)
    summary = collected.text
    costUsd = collected.costUsd
    if (collected.isError) {
      ok = false
      if (collected.errorText) summary = collected.errorText
    }
  } catch (err) {
    ok = false
    summary = err instanceof Error ? err.message : String(err)
  } finally {
    clearTimeout(timeoutHandle)
  }

  // Truncate to reasonable storage length
  if (summary.length > MAX_SUMMARY) {
    summary = summary.slice(0, MAX_SUMMARY) + '…'
  }

  return { ok, summary, costUsd }
}

// ─── Run a single scheduled run now ────────────────────────────────────────

// Guard against overlapping runs of the same routine
const inFlight = new Set<string>()

export async function runScheduledRunNow(id: string): Promise<{ ok: boolean; summary: string; costUsd: number } | null> {
  if (!isSafeId(id)) return null
  const p = fileFor(id)
  if (!fs.existsSync(p)) return null

  let run: ScheduledRun
  try {
    run = readJsonFile<ScheduledRun>(p)
  } catch {
    return null
  }

  if (inFlight.has(id)) return null
  inFlight.add(id)

  let result: { ok: boolean; summary: string; costUsd: number }
  try {
    result = await executeHeadless(run)
  } catch (err) {
    result = { ok: false, summary: err instanceof Error ? err.message : String(err), costUsd: 0 }
  } finally {
    inFlight.delete(id)
  }

  const now = Date.now()
  // A routine may have been edited, disabled or deleted while its run was active.
  if (!fs.existsSync(p)) return result
  const latest = readJsonFile<ScheduledRun>(p)
  const updated: ScheduledRun = {
    ...latest,
    lastRunAt: now,
    lastResult: { ...result, at: now },
    nextRunAt: latest.enabled ? computeNextRun(latest, now) : latest.nextRunAt
  }
  try {
    writeJsonAtomic(p, updated)
  } catch {
    // best-effort
  }

  // Desktop notification
  if (Notification.isSupported()) {
    const n = new Notification({
      title: run.name,
      body: result.ok
        ? `Routine completed · $${result.costUsd.toFixed(4)}`
        : `Routine failed: ${result.summary.slice(0, 100)}`,
      silent: false
    })
    n.show()
  }

  return result
}

// ─── Timer loop ────────────────────────────────────────────────────────────

let timerHandle: ReturnType<typeof setInterval> | null = null

async function tick(): Promise<void> {
  const now = Date.now()
  const runs = listScheduledRuns()
  for (const run of runs) {
    if (!run.enabled) continue
    if (inFlight.has(run.id)) continue
    const due = run.nextRunAt ?? computeNextRun(run, run.lastRunAt ?? run.createdAt)
    if (due <= now) {
      // Fire and forget — errors are recorded inside runScheduledRunNow
      runScheduledRunNow(run.id).catch(() => {
        // swallow — recorded in lastResult
      })
    }
  }
}

export function startScheduler(): void {
  // Recompute nextRunAt for all enabled runs on startup
  const runs = listScheduledRuns()
  for (const run of runs) {
    if (!run.enabled) continue
    if (!run.nextRunAt || run.nextRunAt < Date.now()) {
      const updated: ScheduledRun = {
        ...run,
        nextRunAt: startupRunTime(run, Date.now(), computeNextRun(run, Date.now()))
      }
      try {
        writeJsonAtomic(fileFor(run.id), updated)
      } catch {
        // best-effort
      }
    }
  }

  if (timerHandle) clearInterval(timerHandle)
  // Check every 30 seconds
  timerHandle = setInterval(() => {
    tick().catch(() => {
      // swallow tick errors
    })
  }, 30_000)
}
