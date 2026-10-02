import type { OpsLiveEvent } from '../types'

/**
 * Pure fold of live ops ledger lines (`ops:event`) into runs and call rows for the ops
 * timeline panel. No React, no IPC: the panel feeds it the events it has seen, in arrival
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
}

export interface OpsRun {
  runId: string
  /** ISO time of run.start, or of the first line seen for the run when that is missing. */
  startedAt: string
  runbook: string
  hosts: string[]
  planText?: string
  planDecision?: 'approved' | 'rejected'
  /** ISO time of the plan decision. */
  planAt?: string
  calls: OpsRow[]
  ended?: { ok: boolean; aborted?: boolean; error?: string; costUsd: number }
}

/** Rows of statuses that mean "this did not go as planned" (red in the panel). */
export const OPS_BAD_STATUSES: ReadonlySet<OpsRowStatus> = new Set(['denied', 'failed', 'timed-out', 'stopped'])

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((w) => typeof w === 'string') ? (v as string[]) : undefined
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function blankRow(callId: string): OpsRow {
  return { callId, host: '', tool: '', class: '', decision: '', reason: 'decided event missing', status: 'decided' }
}

/** Runs in first-seen order; the panel reverses for newest first. */
export function foldOpsEvents(events: OpsLiveEvent[]): OpsRun[] {
  const runs = new Map<string, OpsRun>()
  const rows = new Map<string, Map<string, OpsRow>>()

  const runFor = (runId: string, at: string): OpsRun => {
    let run = runs.get(runId)
    if (!run) {
      run = { runId, startedAt: at, runbook: '', hosts: [], calls: [] }
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
        const rb = e.runbook as { name?: unknown } | undefined
        run.runbook = str(rb?.name) ?? run.runbook
        const hosts = Array.isArray(e.hosts) ? (e.hosts as { name?: unknown }[]) : []
        run.hosts = hosts.map((h) => str(h?.name)).filter((n): n is string => !!n)
        const plan = str(e.planText)
        if (plan) run.planText = plan
        break
      }
      case 'call.decided': {
        if (!callId) break
        const row = rowFor(run, callId)
        row.host = str(e.host) ?? ''
        row.tool = str(e.tool) ?? ''
        row.class = str(e.class) ?? ''
        row.decision = str(e.decision) ?? ''
        row.reason = str(e.reason) ?? ''
        row.rule = str(e.rule)
        row.title = str(e.title)
        row.argv = strArr(e.argv)
        row.path = str(e.path)
        row.status = row.decision === 'deny' ? 'denied' : 'decided'
        break
      }
      case 'call.asked': {
        if (!callId) break
        rowFor(run, callId).status = 'asked'
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
      case 'plan.approved':
      case 'plan.rejected': {
        run.planDecision = e.kind === 'plan.approved' ? 'approved' : 'rejected'
        run.planAt = ev.line.at
        break
      }
      case 'run.end': {
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
