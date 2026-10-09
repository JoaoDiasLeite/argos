import type { OpsLiveEvent } from '../types'
import { makeT, type TFunction } from '../../../shared/i18n'

// Text helpers take the translator last and default to English, so callers that have
// not been handed `t` yet keep compiling and reading as before.
const EN = makeT('en')

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
  /** Every approved plan, in order, with the call count at its approval: a run that
   *  proposes a second plan midway keeps the first one's steps for its earlier calls. */
  plans?: { steps: OpsPlanStepRow[]; callIndex: number }[]
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
            ;(run.plans ??= []).push({ steps, callIndex: run.calls.length })
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
 * "k of n steps" for a run whose plan was approved: n is the latest plan's steps the
 * operator did not skip, k those finished. A step is finished once it made calls, all of
 * them reached an outcome, and the run has moved past it: a later step made a call, or
 * the run ended. Counting calls instead read "8 of 8" while step 2 of 8 was running. Null
 * without an approved plan, or when every step was skipped.
 */
export function planProgress(run: OpsRun): { done: number; total: number } | null {
  if (run.planDecision !== 'approved' || !run.planSteps?.length) return null
  const total = run.planSteps.filter((s) => !s.skipped).length
  if (total === 0 || !run.plans?.length) return null
  const prefix = `p${run.plans.length - 1}:s`
  const steps = groupCallsBySteps(run).filter((g) => g.key.startsWith(prefix))
  const skipped = new Set(run.planSteps.flatMap((s, i) => (s.skipped ? [`${prefix}${i}`] : [])))
  let done = 0
  steps.forEach((g, i) => {
    if (skipped.has(g.key) || g.rows.length === 0 || !g.rows.every((r) => SETTLED.has(r.status))) return
    const movedOn = !!run.ended || steps.slice(i + 1).some((later) => later.rows.length > 0)
    if (movedOn) done++
  })
  return { done: Math.min(done, total), total }
}

export type OpsRowTone = 'ok' | 'warn' | 'bad' | 'idle'

/** The program a call ran: argv[0] without its path, past a leading sudo and its options. */
function programOf(argv: string[]): { name: string; rest: string[] } {
  let i = 0
  if (argv[0] === 'sudo') {
    i = 1
    while (i < argv.length && argv[i].startsWith('-')) {
      // The options that take a value as the next word.
      if (/^-[ugCDpRrTt]$/.test(argv[i])) i++
      i++
    }
  }
  const name = (argv[i] ?? '').split('/').pop() ?? ''
  return { name, rest: argv.slice(i + 1) }
}

/**
 * What a non-zero exit means when it is an answer, not a failure: pgrep finding no
 * process, systemctl reporting a unit stopped or missing, grep finding no line. A
 * diagnosis asks these questions on purpose, so the column says the answer in grey
 * instead of raising an amber "exit 1". Undefined when the exit is a real failure.
 */
export function exitMeaning(row: OpsRow, t: TFunction = EN): string | undefined {
  if (row.status !== 'failed' || row.exitCode == null || !row.argv?.length) return undefined
  const { name, rest } = programOf(row.argv)
  const code = row.exitCode
  switch (name) {
    case 'pgrep':
      return code === 1 ? t('ops.timeline.exit.noProcess') : undefined
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'zgrep':
      return code === 1 ? t('ops.timeline.exit.noMatch') : undefined
    case 'diff':
      return code === 1 ? t('ops.timeline.exit.differs') : undefined
    case 'systemctl': {
      const verb = rest.find((w) => !w.startsWith('-'))
      if (verb === 'status') return code === 3 ? t('ops.timeline.exit.inactive') : code === 4 ? t('ops.timeline.exit.noUnit') : undefined
      if (verb === 'is-active') return code === 3 || code === 4 ? t('ops.timeline.exit.inactive') : undefined
      if (verb === 'is-enabled') return code === 1 ? t('ops.timeline.exit.disabled') : undefined
      if (verb === 'is-failed') return code === 1 ? t('ops.timeline.exit.notFailed') : undefined
      return undefined
    }
    default:
      return undefined
  }
}

/** The row's dot: green ran, amber asks or exited non-zero, red refused, grey otherwise. */
export function rowTone(row: OpsRow): OpsRowTone {
  if (exitMeaning(row)) return 'idle'
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
export function deniedLabel(row: OpsRow, t: TFunction = EN): string {
  if (row.answer === 'deny' || /^the operator refused/.test(row.reason)) return t('ops.timeline.denied.you')
  if (/^outside this intervention's scope/.test(row.reason)) return t('ops.timeline.denied.scope')
  const r = row.reason
  if (/^denylisted:/.test(r)) return t('ops.timeline.denied.never')
  if (/^sudo command matches no literal sudo rule/.test(r)) return t('ops.timeline.denied.sudoRule')
  if (/takes at most \d+ argument/.test(r) || /does not match the script's pattern/.test(r) || /^script args must/.test(r)) return t('ops.timeline.denied.scriptArgs')
  if (/no valid pinned sha256/.test(r)) return t('ops.timeline.denied.notPinned')
  if (/is not allowed on this host|^host is not in this runbook/.test(r)) return t('ops.timeline.denied.host')
  if (/^path .* is not under any/.test(r)) return t('ops.timeline.denied.path')
  if (/runs another command/.test(r)) return t('ops.timeline.denied.notSimple')
  return t('ops.timeline.denied.notInRunbook')
}

/** The row's right-hand label: duration, `exit N`, or why it did not run. */
export function rowLabel(row: OpsRow, t: TFunction = EN): string {
  const meaning = exitMeaning(row, t)
  if (meaning) return meaning
  switch (row.status) {
    case 'done':
      return formatDuration(row.durationMs)
    case 'failed':
      return row.exitCode == null ? t('ops.timeline.row.failed') : t('ops.timeline.row.exit', { code: row.exitCode })
    case 'timed-out':
      return t('ops.timeline.row.timedOut')
    case 'denied':
      return deniedLabel(row, t)
    case 'stopped':
      return t('ops.timeline.row.stopped')
    case 'asked':
      return t('ops.timeline.row.waiting')
    case 'queued':
      return t('ops.timeline.row.queued')
    case 'running':
      return t('ops.timeline.row.running')
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

// ── Calls by plan step ──

/** One heading of the activity column: a plan step and the calls made for it. */
export interface OpsStepGroup {
  key: string
  /** The step's title, or "Before the plan" for what ran before any approval. */
  title: string
  /** 1-based step number within its plan; absent for the before-the-plan group. */
  n?: number
  rows: OpsRow[]
  /** Index in run.calls of the group's first row (its rows are contiguous). */
  firstCall: number
}

/** Quotes and runs of spaces differ between a plan's line and the argv the gate parsed. */
const loose = (s: string): string => s.replace(/['"]/g, '').replace(/\s+/g, ' ').trim()

/** The call as a line comparable with a plan step's commands. A plan spells a script step
 *  `script <name> <args>` and the gate's argv is the bare `<name> <args>`, so a script call
 *  takes the same prefix, or no script call would ever match its step. */
function callLine(row: OpsRow): string {
  if (row.tool === 'script' && row.argv?.length) {
    const [name, ...args] = row.argv
    return loose(['script', name.split('/').pop() ?? name, ...args].join(' '))
  }
  if (row.argv?.length) return loose(row.argv.join(' '))
  return loose([row.tool, row.path].filter(Boolean).join(' '))
}

function stepClaims(step: OpsPlanStepRow, line: string): boolean {
  if (!line) return false
  return step.commands.some((c) => {
    const cmd = loose(c)
    return cmd !== '' && (cmd === line || line.startsWith(cmd) || cmd.startsWith(line))
  })
}

/**
 * The run's calls under the plan steps they carried out. Calls before the first approved
 * plan form their own group. After an approval each call goes to the first step at or past
 * the current one whose commands it matches, and otherwise stays on the current step, so a
 * call the model phrased differently from its plan still lands in order. Only steps that
 * made a call are listed: the column is a history of what ran, and the plan's length is
 * already in its "k of n steps".
 */
export function groupCallsBySteps(run: OpsRun, t: TFunction = EN): OpsStepGroup[] {
  const plans = run.plans ?? []
  const groups: OpsStepGroup[] = []
  const firstPlanAt = plans.length ? plans[0].callIndex : run.calls.length
  if (firstPlanAt > 0) {
    groups.push({ key: 'pre', title: t('ops.timeline.group.beforePlan'), rows: run.calls.slice(0, firstPlanAt), firstCall: 0 })
  }
  plans.forEach((plan, k) => {
    const end = k + 1 < plans.length ? plans[k + 1].callIndex : run.calls.length
    const steps = plan.steps.map((s, i) => ({
      group: { key: `p${k}:s${i}`, title: s.title, n: i + 1, rows: [] as OpsRow[], firstCall: -1 },
      step: s
    }))
    const live = steps.filter((s) => !s.step.skipped)
    if (live.length === 0) {
      if (end > plan.callIndex) {
        groups.push({ key: `p${k}:extra`, title: t('ops.timeline.group.outsidePlan'), rows: run.calls.slice(plan.callIndex, end), firstCall: plan.callIndex })
      }
      return
    }
    let at = 0
    for (let c = plan.callIndex; c < end; c++) {
      const row = run.calls[c]
      const line = callLine(row)
      const found = live.findIndex((s, j) => j >= at && stepClaims(s.step, line))
      if (found >= 0) at = found
      const g = live[at].group
      if (g.firstCall < 0) g.firstCall = c
      g.rows.push(row)
    }
    for (const s of steps) if (s.group.rows.length > 0) groups.push(s.group)
  })
  return groups
}

/**
 * The group the run is on: the latest call's. Null once the run has ended, so the column
 * stops moving, and while a just-approved plan has not made a call yet, so the previous
 * plan's last step does not stay open as if it were current.
 */
export function currentStepKey(run: OpsRun, groups: OpsStepGroup[]): string | null {
  if (run.ended || groups.length === 0) return null
  const last = run.calls.length - 1
  const latestPlan = run.plans?.[run.plans.length - 1]
  if (latestPlan && latestPlan.callIndex > last) return null
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i]
    if (g.rows.length && g.firstCall <= last && last < g.firstCall + g.rows.length) return g.key
  }
  return null
}
