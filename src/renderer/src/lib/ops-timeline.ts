import type { OpsLiveEvent } from '../types'

/**
 * Pure fold of live ops ledger lines (`ops:event`) into runs and call rows for the ops
 * activity column and the run report. No React, no IPC: the panel feeds it the events it has seen, in arrival
 * order, and renders what comes back.
 */

export type OpsRowStatus =
  | 'decided'
  | 'asked'
  | 'queued'
  | 'running'
  | 'done'
  | 'denied'
  | 'failed'
  | 'timed-out'
  | 'stopped'

export interface OpsRow {
  callId: string
  host: string
  tool: string
  class: string
  decision: string
  reason: string
  rule?: string
  title?: string
  argv?: string[]
  path?: string
  answer?: 'allow' | 'deny' | 'stop'
  status: OpsRowStatus
  exitCode?: number | null
  durationMs?: number
  stdoutHead?: string
  stderrHead?: string
  backup?: { path: string; backupPath: string }
  /** ISO time of call.decided. */
  at?: string
  /** The gate asked the operator about this call. */
  asked?: boolean
}

export interface OpsPlanStepRow {
  title: string
  commands: string[]
  verdict: string
  hostName?: string
  /** The operator approved the plan without this step (`plan.approved.skippedSteps`). */
  skipped?: true
}

export interface OpsRun {
  runId: string
  /** ISO time of run.start, or of the first line seen for the run when that is missing. */
  startedAt: string
  runbook: string
  hosts: string[]
  planText?: string
  /** Host id → name, from run.start, so rows can show the name instead of the address. */
  hostNames?: Record<string, string>
  planDecision?: 'approved' | 'rejected'
  /** The latest approved plan's steps, as logged with plan.approved. */
  planSteps?: OpsPlanStepRow[]
  /** ISO time of the plan decision. */
  planAt?: string
  calls: OpsRow[]
  ended?: { ok: boolean; aborted?: boolean; error?: string; costUsd: number }
  /** ISO time of run.end. */
  endedAt?: string
  /** The intervention's words and scope, from run.start (absent on older runs). */
  task?: string
  ticket?: string
  client?: string
  scope?: { kind: 'host'; hostId: string } | { kind: 'open' }
  policySha256?: string
  /** The operator's answers to a host's first touch in an open intervention, in order. */
  hostAnswers: OpsHostAnswer[]
  /** How many calls the run had when its plan was approved; the steps count from there. */
  planCallIndex?: number
}

export interface OpsHostAnswer {
  hostId: string
  host: string
  answer: 'approved' | 'denied'
  at: string
  /** How many calls the run had when the answer came, so the column can place the line
   *  among the rows. */
  beforeCall: number
}

/** Rows of statuses that mean "this did not go as planned" (red in the panel). */
export const OPS_BAD_STATUSES: ReadonlySet<OpsRowStatus> = new Set(['denied', 'failed', 'timed-out', 'stopped'])

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((w) => typeof w === 'string') ? (v as string[]) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** A ledger line's plan steps, keeping only well-formed ones; undefined when there are none. */
function planStepsOf(v: unknown): OpsPlanStepRow[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: OpsPlanStepRow[] = []
  for (const s of v as Record<string, unknown>[]) {
    const title = str(s?.title)
    if (title === undefined) continue
    const hostName = str(s.hostName)
    out.push({ title, commands: strArr(s.commands) ?? [], verdict: str(s.verdict) ?? '', ...(hostName ? { hostName } : {}) })
  }
  return out.length ? out : undefined
}

function blankRow(callId: string): OpsRow {
  return { callId, host: '', tool: '', class: '', decision: '', reason: 'decided event missing', status: 'decided' }
}

/** Runs in first-seen order; the panel reverses for newest first. */
export function foldOpsEvents(events: OpsLiveEvent[]): OpsRun[] {
  const runs = new Map<string, OpsRun>()
  const rows = new Map<string, Map<string, OpsRow>>()
  // Runs whose plan text came with run.start: that text stays, as in the main-side fold.
  const startPlans = new Set<string>()

  const runFor = (runId: string, at: string): OpsRun => {
    let run = runs.get(runId)
    if (!run) {
      run = { runId, startedAt: at, runbook: '', hosts: [], calls: [], hostAnswers: [] }
      runs.set(runId, run)
      rows.set(runId, new Map())
    }
    return run
  }
  const rowFor = (run: OpsRun, callId: string): OpsRow => {
    const byId = rows.get(run.runId)!
    let row = byId.get(callId)
    if (!row) {
      row = blankRow(callId)
      byId.set(callId, row)
      run.calls.push(row)
    }
    return row
  }

  for (const ev of events) {
    const e = ev.line?.event
    if (!e || typeof e.kind !== 'string') continue
    const runId = str(e.runId) ?? ev.runId
    if (!runId) continue
    const run = runFor(runId, ev.line.at)
    const callId = str(e.callId)

    switch (e.kind) {
      case 'run.start': {
        run.startedAt = ev.line.at
        const rb = e.runbook as { name?: unknown; policySha256?: unknown } | undefined
        run.runbook = str(rb?.name) ?? run.runbook
        run.policySha256 = str(rb?.policySha256)
        run.task = str(e.task) || undefined
        run.ticket = str(e.ticket) || undefined
        run.client = str(e.client) || undefined
        const sc = e.scope as { kind?: unknown; hostId?: unknown } | undefined
        const scopeHost = str(sc?.hostId)
        if (sc?.kind === 'open') run.scope = { kind: 'open' }
        else if (sc?.kind === 'host' && scopeHost) run.scope = { kind: 'host', hostId: scopeHost }
        const hosts = Array.isArray(e.hosts) ? (e.hosts as { id?: unknown; name?: unknown }[]) : []
        run.hosts = hosts.map((h) => str(h?.name)).filter((n): n is string => !!n)
        // call.decided carries the address; the operator thinks in host names.
        run.hostNames = Object.fromEntries(
          hosts.flatMap((h) => (str(h?.id) && str(h?.name) ? [[str(h.id) as string, str(h.name) as string]] : []))
        )
        const plan = str(e.planText)
        if (plan) {
          run.planText = plan
          startPlans.add(runId)
        }
        break
      }
      case 'call.decided': {
        if (!callId) break
        const row = rowFor(run, callId)
        row.host = run.hostNames?.[str(e.hostId) ?? ''] ?? str(e.host) ?? ''
        row.tool = str(e.tool) ?? ''
        row.class = str(e.class) ?? ''
        row.decision = str(e.decision) ?? ''
        row.reason = str(e.reason) ?? ''
        row.rule = str(e.rule)
        row.title = str(e.title)
        row.argv = strArr(e.argv)
        row.path = str(e.path)
        row.at = ev.line.at
        row.status = row.decision === 'deny' ? 'denied' : 'decided'
        break
      }
      case 'call.asked': {
        if (!callId) break
        const row = rowFor(run, callId)
        row.status = 'asked'
        row.asked = true
        break
      }
      case 'call.answered': {
        if (!callId) break
        const row = rowFor(run, callId)
        const answer = e.answer
        if (answer === 'allow' || answer === 'deny' || answer === 'stop') row.answer = answer
        row.status = answer === 'allow' ? 'queued' : answer === 'stop' ? 'stopped' : 'denied'
        break
      }
      case 'call.started': {
        if (!callId) break
        rowFor(run, callId).status = 'running'
        break
      }
      case 'call.finished': {
        if (!callId) break
        const row = rowFor(run, callId)
        const exitCode = typeof e.exitCode === 'number' ? e.exitCode : null
        const timedOut = e.timedOut === true
        row.exitCode = exitCode
        row.durationMs = num(e.durationMs)
        row.stdoutHead = str(e.stdoutHead)
        row.stderrHead = str(e.stderrHead)
        row.status = timedOut ? 'timed-out' : exitCode === 0 ? 'done' : 'failed'
        break
      }
      case 'write.backup': {
        if (!callId) break
        const path = str(e.path)
        const backupPath = str(e.backupPath)
        if (path && backupPath) rowFor(run, callId).backup = { path, backupPath }
        break
      }
      case 'host.approved':
      case 'host.denied': {
        const hostId = str(e.hostId)
        if (!hostId) break
        run.hostAnswers.push({
          hostId,
          host: str(e.host) ?? hostId,
          answer: e.kind === 'host.approved' ? 'approved' : 'denied',
          at: ev.line.at,
          beforeCall: run.calls.length
        })
        break
      }
      case 'plan.approved':
      case 'plan.rejected': {
        run.planDecision = e.kind === 'plan.approved' ? 'approved' : 'rejected'
        run.planAt = ev.line.at
        if (e.kind === 'plan.approved') run.planCallIndex = run.calls.length
        // Only an approved plan is the run's plan; a rejected one is just a decision.
        if (e.kind === 'plan.approved') {
          const steps = planStepsOf(e.steps)
          if (steps) {
            const skipped = Array.isArray(e.skippedSteps) ? (e.skippedSteps as unknown[]) : []
            for (const i of skipped) if (typeof i === 'number' && steps[i]) steps[i].skipped = true
            run.planSteps = steps
          }
          const plan = str(e.planText)
          if (plan && !startPlans.has(runId)) run.planText = plan
        }
        break
      }
      case 'run.end': {
        run.endedAt = ev.line.at
        run.ended = {
          ok: e.ok === true,
          costUsd: num(e.costUsd) ?? 0,
          ...(e.aborted === true ? { aborted: true } : {}),
          ...(str(e.error) ? { error: str(e.error) } : {})
        }
        break
      }
      default:
        break
    }
  }
  return [...runs.values()]
}


// ── The activity column's reading of a run ──

/** Calls that reached an outcome: ran, failed, timed out, refused or stopped. */
const SETTLED: ReadonlySet<OpsRowStatus> = new Set(['done', 'failed', 'timed-out', 'denied', 'stopped'])

/**
 * "k of n steps" for a run whose plan was approved: n is the plan's steps the operator did
 * not skip, k the calls that reached an outcome since the approval, capped at n. Null
 * without an approved plan, or when every step was skipped.
 */
export function planProgress(run: OpsRun): { done: number; total: number } | null {
  if (run.planDecision !== 'approved' || !run.planSteps?.length) return null
  const total = run.planSteps.filter((s) => !s.skipped).length
  if (total === 0) return null
  const since = run.calls.slice(run.planCallIndex ?? 0)
  const done = Math.min(total, since.filter((c) => SETTLED.has(c.status)).length)
  return { done, total }
}

export type OpsRowTone = 'ok' | 'warn' | 'bad' | 'idle'

/** The row's dot: green ran, amber asks or exited non-zero, red refused, grey otherwise. */
export function rowTone(row: OpsRow): OpsRowTone {
  switch (row.status) {
    case 'done':
      return 'ok'
    case 'asked':
    case 'failed':
    case 'timed-out':
      return 'warn'
    case 'denied':
    case 'stopped':
      return 'bad'
    default:
      return 'idle'
  }
}

export function formatDuration(ms?: number): string {
  if (ms == null) return ''
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** Why a refused call was refused, in the column's few words. */
export function deniedLabel(row: OpsRow): string {
  if (row.answer === 'deny' || /^the operator refused/.test(row.reason)) return 'denied by you'
  if (/^outside this intervention's scope/.test(row.reason)) return 'outside scope'
  const r = row.reason
  if (/^denylisted:/.test(r)) return 'never allowed'
  if (/^sudo command matches no literal sudo rule/.test(r)) return 'sudo rule missing'
  if (/takes at most \d+ argument/.test(r) || /does not match the script's pattern/.test(r) || /^script args must/.test(r)) return 'bad script args'
  if (/no valid pinned sha256/.test(r)) return 'script not pinned'
  if (/is not allowed on this host|^host is not in this runbook/.test(r)) return 'wrong host'
  if (/^path .* is not under any/.test(r)) return 'path not allowed'
  if (/runs another command/.test(r)) return 'not a simple command'
  return 'not in runbook'
}

/** The row's right-hand label: duration, `exit N`, or why it did not run. */
export function rowLabel(row: OpsRow): string {
  switch (row.status) {
    case 'done':
      return formatDuration(row.durationMs)
    case 'failed':
      return row.exitCode == null ? 'failed' : `exit ${row.exitCode}`
    case 'timed-out':
      return 'timed out'
    case 'denied':
      return deniedLabel(row)
    case 'stopped':
      return 'stopped'
    case 'asked':
      return 'waiting'
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    default:
      return ''
  }
}

/** The tiles of a run report: calls, ran, asked the operator, not allowed. */
export function runCounts(run: OpsRun): { calls: number; ran: number; asked: number; notAllowed: number } {
  let ran = 0
  let asked = 0
  let notAllowed = 0
  for (const c of run.calls) {
    if (c.status === 'done' || c.status === 'failed' || c.status === 'timed-out') ran++
    if (c.asked) asked++
    if (c.status === 'denied' || c.status === 'stopped') notAllowed++
  }
  return { calls: run.calls.length, ran, asked, notAllowed }
}

/** Host names the run reached (approved hosts, then hosts of calls not refused), first seen first. */
export function touchedHosts(run: OpsRun): string[] {
  const out: string[] = []
  const add = (h: string) => {
    if (h && !out.includes(h)) out.push(h)
  }
  for (const a of run.hostAnswers) if (a.answer === 'approved') add(a.host)
  for (const c of run.calls) if (c.status !== 'denied') add(c.host)
  return out
}

/**
 * The run on screen and the ones before it. The current run is the one with `currentRunId`
 * when one is given (none if its first line has not arrived, or the id is empty), else the newest;
 * earlier runs come newest first.
 */
export function splitRuns(runs: OpsRun[], currentRunId?: string): { current?: OpsRun; earlier: OpsRun[] } {
  const newestFirst = [...runs].reverse()
  const current = currentRunId !== undefined ? newestFirst.find((r) => r.runId === currentRunId) : newestFirst[0]
  const earlier = newestFirst.filter((r) => r !== current)
  // Ledger order is time order; sort anyway, so a day file read late cannot shuffle them.
  earlier.sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return { current, earlier }
}
