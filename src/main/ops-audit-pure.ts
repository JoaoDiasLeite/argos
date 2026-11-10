/**
 * The ops audit ledger's line format, hash chain and per-run fold
 * (docs/OPS_AGENT_PLAN.md §5). Pure: the disk half (`ops-audit.ts`, O_APPEND writes under
 * userData/ops-audit/) lives elsewhere, so the format can be tested without Electron.
 *
 * The chain is tamper-EVIDENT, not tamper-proof. Each line carries the sha256 of the
 * previous line's exact text, so an edited, deleted or reordered line breaks the chain at
 * the next link. Anyone with write access can still rewrite the whole file and recompute
 * every hash; nothing here is signed. What it buys is that a casual edit or a trimmed file
 * is detectable, not that the file is trustworthy against its own owner.
 */

import { createHash } from 'crypto'
import type {
  OpsAuditEvent,
  OpsAuditLine,
  OpsClass,
  OpsDecision,
  OpsHostRef,
  OpsLoggedPlanStep,
  OpsRunbookRef,
  OpsScope,
  OpsToolName
} from './ops-types'

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

/** The `prev` of the first line of every ledger file. */
export const GENESIS = 'genesis'

/**
 * Build the next ledger line. `prevRaw` is the previous line's exact text (null at file
 * start), so the hash is over the bytes on disk and not over a re-serialisation that
 * could differ. The returned raw text is a single line; the writer appends `\n`.
 */
export function buildLine(
  prevRaw: string | null,
  event: OpsAuditEvent,
  at: Date
): { raw: string; line: OpsAuditLine } {
  const line: OpsAuditLine = {
    at: at.toISOString(),
    prev: prevRaw === null ? GENESIS : sha256Hex(prevRaw),
    event
  }
  const raw = JSON.stringify(line)
  // JSON.stringify escapes newlines inside strings, so this cannot fire today. It stays
  // as an assertion because a raw newline would split one event into two broken lines.
  if (raw.includes('\n') || raw.includes('\r')) throw new Error('ledger line contains a newline')
  return { raw, line }
}

type ScanItem =
  | { lineNo: number; raw: string; line: OpsAuditLine }
  | { lineNo: number; raw: string; error: string }

interface Scan {
  items: ScanItem[]
  partial?: { line: number; text: string }
}

function shapeError(value: unknown): string | null {
  if (!value || typeof value !== 'object') return 'not an object'
  const v = value as Record<string, unknown>
  if (typeof v.at !== 'string') return 'missing "at"'
  if (typeof v.prev !== 'string') return 'missing "prev"'
  const ev = v.event as Record<string, unknown> | undefined
  if (!ev || typeof ev !== 'object' || typeof ev.kind !== 'string') return 'missing "event.kind"'
  return null
}

/**
 * One pass over the file. Blank lines are skipped (an editor may leave one at the end).
 * The writer always ends a line with `\n` in the same write, so a last segment without a
 * newline is an interrupted append: reported as partial and left out, never an error.
 */
function scan(text: string): Scan {
  const segments = text.split('\n')
  const last = segments.pop() as string
  const items: ScanItem[] = []
  segments.forEach((raw, i) => {
    if (raw.trim() === '') return
    const lineNo = i + 1
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      items.push({ lineNo, raw, error: `invalid JSON: ${(err as Error).message}` })
      return
    }
    const bad = shapeError(parsed)
    if (bad) items.push({ lineNo, raw, error: bad })
    else items.push({ lineNo, raw, line: parsed as OpsAuditLine })
  })
  const out: Scan = { items }
  if (last.trim() !== '') out.partial = { line: segments.length + 1, text: last }
  return out
}

/**
 * Parse a ledger file's text. Bad lines are reported with their 1-based line number and
 * never thrown, so one corrupt line does not hide the rest of the day. `partial` is the
 * trailing line with no newline, when there is one.
 */
export function parseLedger(text: string): {
  lines: OpsAuditLine[]
  raws: string[]
  errors: { line: number; reason: string }[]
  partial?: { line: number; text: string }
} {
  const s = scan(text)
  const lines: OpsAuditLine[] = []
  const raws: string[] = []
  const errors: { line: number; reason: string }[] = []
  for (const item of s.items) {
    if ('error' in item) errors.push({ line: item.lineNo, reason: item.error })
    else {
      lines.push(item.line)
      raws.push(item.raw)
    }
  }
  return s.partial ? { lines, raws, errors, partial: s.partial } : { lines, raws, errors }
}

/**
 * Verify the hash chain over the complete lines. An unparseable line is itself a broken
 * link (its successor's hash may still match, but we cannot vouch for its content). A
 * trailing partial line is ignored: the chain is reported ok up to it.
 */
export function verifyChain(
  text: string
): { ok: true; lines: number } | { ok: false; brokenAt: number; reason: string } {
  const s = scan(text)
  let prevRaw: string | null = null
  for (const item of s.items) {
    if ('error' in item) return { ok: false, brokenAt: item.lineNo, reason: item.error }
    const expected = prevRaw === null ? GENESIS : sha256Hex(prevRaw)
    if (item.line.prev !== expected) {
      return {
        ok: false,
        brokenAt: item.lineNo,
        reason:
          prevRaw === null
            ? `first line's prev is not "${GENESIS}"`
            : "prev does not match the previous line's hash"
      }
    }
    prevRaw = item.raw
  }
  return { ok: true, lines: s.items.length }
}

/** Events of one run, in file order. */
export function runEvents(lines: OpsAuditLine[], runId: string): OpsAuditLine[] {
  return lines.filter((l) => l.event.runId === runId)
}

export interface OpsCallSummary {
  callId: string
  tool: OpsToolName
  hostId: string
  host: string
  class: OpsClass
  decision: OpsDecision
  reason: string
  rule?: string
  title?: string
  argv?: string[]
  path?: string
  rawInput: unknown
  answer?: 'allow' | 'deny' | 'stop'
  startedAt?: string
  exitCode?: number | null
  timedOut?: boolean
  durationMs?: number
  stdoutHead?: string
  stderrHead?: string
  backup?: { path: string; backupPath: string }
}

export interface OpsRunSummary {
  runId: string
  startedAt: string
  endedAt?: string
  runbook: OpsRunbookRef
  hosts: OpsHostRef[]
  model: string
  /** The intervention's description, ticket, client and scope, from run.start. */
  task?: string
  ticket?: string
  client?: string
  scope?: OpsScope
  /** The diagnosis this intervention follows (run.start.parentRunId). */
  parentRunId?: string
  /** The earlier run this one resumes, and the ones picked as related (run.start). */
  resumesRunId?: string
  relatedRunIds?: string[]
  /** The Claude session the terminal pinned or resumed (run.start.cliSessionId). */
  cliSessionId?: string
  /** Earlier runs the operator pointed the model at mid-run (run.referenced), in order. */
  referencedRunIds?: string[]
  /** What the model read through past_interventions (history.read): run ids, and how
   *  many times it listed the history. Absent when it read nothing. */
  historyReads?: { runIds: string[]; lists: number }
  /** This diagnosis was handed over to a runbook intervention (run.handover). */
  handover?: { runbook: string; childRunId?: string }
  /** Open scope: the operator's answer per host, in the order given. */
  hostAnswers?: { hostId: string; host: string; answer: 'approved' | 'denied' }[]
  /** Hosts whose syslog could not take Argos's lines, once each, with why. */
  syslogUnavailable?: { hostId: string; host: string; reason: string }[]
  planText?: string
  /** The latest approved plan's steps, when the ledger recorded them. */
  planSteps?: OpsLoggedPlanStep[]
  planDecision?: 'approved' | 'rejected'
  calls: OpsCallSummary[]
  ok?: boolean
  aborted?: boolean
  error?: string
  costUsd?: number
}

/**
 * An earlier run this one is linked to (resumed or related), as far as the reports need
 * it: a renderer only gets the run's own lines, so the caller looks these up and passes
 * them in. A link it could not look up is simply left out and the report names the id.
 */
export interface OpsLinkedRun {
  runId: string
  startedAt: string
  task?: string
}

export const DECIDED_MISSING = 'decided event missing'

/**
 * A call event seen before its `call.decided`. The gate logs before it runs, so this
 * means the ledger lost or reordered a line; the call is kept (it may well have run) with
 * the most cautious shape we can give it: unknown host, mutate, ask.
 */
function placeholderCall(callId: string): OpsCallSummary {
  return {
    callId,
    tool: 'run',
    hostId: '',
    host: '',
    class: 'mutate',
    decision: 'ask',
    reason: DECIDED_MISSING,
    rawInput: null
  }
}

/**
 * Fold a run's events into one view the reports and the timeline can render. Null when
 * the run has no `run.start` (nothing to say which runbook or hosts it was).
 */
export function summarizeRun(lines: OpsAuditLine[], runId: string): OpsRunSummary | null {
  const events = runEvents(lines, runId)
  const start = events.find((l) => l.event.kind === 'run.start')
  if (!start || start.event.kind !== 'run.start') return null
  const s: OpsRunSummary = {
    runId,
    startedAt: start.at,
    runbook: start.event.runbook,
    hosts: start.event.hosts,
    model: start.event.model,
    calls: []
  }
  if (start.event.planText !== undefined) s.planText = start.event.planText
  if (start.event.task !== undefined) s.task = start.event.task
  if (start.event.ticket !== undefined) s.ticket = start.event.ticket
  if (start.event.client !== undefined) s.client = start.event.client
  if (start.event.scope !== undefined) s.scope = start.event.scope
  if (start.event.parentRunId !== undefined) s.parentRunId = start.event.parentRunId
  if (start.event.resumesRunId !== undefined) s.resumesRunId = start.event.resumesRunId
  if (start.event.relatedRunIds !== undefined && start.event.relatedRunIds.length) s.relatedRunIds = [...start.event.relatedRunIds]
  if (start.event.cliSessionId !== undefined) s.cliSessionId = start.event.cliSessionId
  const calls = new Map<string, OpsCallSummary>()
  const callFor = (callId: string): OpsCallSummary => {
    let c = calls.get(callId)
    if (!c) {
      c = placeholderCall(callId)
      calls.set(callId, c)
    }
    return c
  }

  for (const { at, event: e } of events) {
    switch (e.kind) {
      case 'run.start':
        break
      case 'plan.approved':
        s.planDecision = 'approved'
        // A terminal run has no plan at run.start: the latest approved plan is the run's.
        if (start.event.planText === undefined && e.planText !== undefined) s.planText = e.planText
        if (e.steps !== undefined) {
          const skipped = new Set(e.skippedSteps ?? [])
          s.planSteps = e.steps.map((p, i) => (skipped.has(i) ? { ...p, skipped: true } : p))
        }
        break
      case 'plan.rejected':
        s.planDecision = 'rejected'
        break
      case 'call.decided': {
        const earlier = calls.get(e.callId)
        const c = callFor(e.callId)
        c.tool = e.tool
        c.hostId = e.hostId
        c.host = e.host
        c.class = e.class
        c.decision = e.decision
        c.rawInput = e.rawInput
        // A decision logged after the call already started is not a gate decision.
        c.reason = earlier ? DECIDED_MISSING : e.reason
        if (e.rule !== undefined) c.rule = e.rule
        if (e.title !== undefined) c.title = e.title
        if (e.argv !== undefined) c.argv = e.argv
        if (e.path !== undefined) c.path = e.path
        break
      }
      case 'call.asked':
        callFor(e.callId)
        break
      case 'call.answered':
        callFor(e.callId).answer = e.answer
        break
      case 'call.started':
        callFor(e.callId).startedAt = at
        break
      case 'call.finished': {
        const c = callFor(e.callId)
        c.exitCode = e.exitCode
        c.timedOut = e.timedOut
        c.durationMs = e.durationMs
        c.stdoutHead = e.stdoutHead
        c.stderrHead = e.stderrHead
        break
      }
      case 'write.backup':
        callFor(e.callId).backup = { path: e.path, backupPath: e.backupPath }
        break
      case 'sudo.password-supplied':
        break
      case 'host.syslog-unavailable':
        ;(s.syslogUnavailable ??= []).push({ hostId: e.hostId, host: e.host, reason: e.reason })
        break
      case 'host.approved':
      case 'host.denied':
        ;(s.hostAnswers ??= []).push({ hostId: e.hostId, host: e.host, answer: e.kind === 'host.approved' ? 'approved' : 'denied' })
        break
      case 'run.handover':
        s.handover = { runbook: e.runbook, ...(e.childRunId !== undefined ? { childRunId: e.childRunId } : {}) }
        break
      case 'run.referenced':
        ;(s.referencedRunIds ??= []).push(e.refRunId)
        break
      case 'history.read': {
        const r = (s.historyReads ??= { runIds: [], lists: 0 })
        // The same run read twice is one run read: the report lists what was seen.
        if (e.refRunId === undefined) r.lists++
        else if (!r.runIds.includes(e.refRunId)) r.runIds.push(e.refRunId)
        break
      }
      case 'run.end':
        s.endedAt = at
        s.ok = e.ok
        s.costUsd = e.costUsd
        if (e.aborted !== undefined) s.aborted = e.aborted
        if (e.error !== undefined) s.error = e.error
        break
    }
  }
  s.calls = [...calls.values()]
  return s
}

// ─── Run list (INTERVENTIONS_PLAN §3, the start screen's history) ────────────────

/** One line of the history list: enough to name a run and reopen its report. */
export interface OpsRunListItem {
  runId: string
  appSessionId: string
  startedAt: string
  endedAt?: string
  /** The runbook folder's name. */
  runbook: string
  /** The runbook folder's path (run.start.runbook.path): what a resume loads again. */
  runbookPath: string
  /** The runbook ran added to the base intervention (run.start.runbook.base): a resume
   *  loads it on the base again, not alone. */
  onBase?: true
  /** The hosts the run was about: its locked host, the hosts an open run touched, or (before interventions) every runbook host. */
  hostNames: string[]
  task?: string
  /** The rest of what a resume starts from: the run's scope, ticket and client, the Claude
   *  session it can continue, and the run it itself resumed. */
  scope?: OpsScope
  ticket?: string
  client?: string
  cliSessionId?: string
  resumesRunId?: string
  ok?: boolean
  aborted?: boolean
  calls: number
  costUsd?: number
  /** What the run came to, in one line: the model's summary, else its first confirmed
   *  hypothesis, finding or hypothesis. Absent when it noted nothing. */
  headline?: string
  /** How many findings and hypotheses the model noted. */
  findings?: number
  hypotheses?: number
  /** Hypotheses whose last note left them open: what a resume would pick up. */
  openHypotheses?: number
}

/** The ids of the hosts a run was about, in the sense of OpsRunListItem.hostNames. */
export function runHostIds(s: OpsRunSummary): string[] {
  if (s.scope?.kind === 'host') return [s.scope.hostId]
  if (s.scope?.kind === 'open') {
    const ids = [...s.calls.map((c) => c.hostId), ...(s.hostAnswers ?? []).filter((a) => a.answer === 'approved').map((a) => a.hostId)]
    return [...new Set(ids.filter((id) => id !== ''))]
  }
  return s.hosts.map((h) => h.id)
}

/** Whether a run belongs in one host's history. */
export function runTouchesHost(s: OpsRunSummary, hostId: string): boolean {
  return runHostIds(s).includes(hostId)
}

export function runListItem(
  s: OpsRunSummary,
  appSessionId: string,
  notes?: { headline?: string; findings: number; hypotheses: number; openHypotheses?: number }
): OpsRunListItem {
  const nameOf = (id: string): string =>
    s.hosts.find((h) => h.id === id)?.name ?? s.calls.find((c) => c.hostId === id)?.host ?? s.hostAnswers?.find((a) => a.hostId === id)?.host ?? id
  return {
    runId: s.runId,
    appSessionId,
    startedAt: s.startedAt,
    ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
    runbook: s.runbook.name,
    runbookPath: s.runbook.path,
    ...(s.runbook.base ? { onBase: true as const } : {}),
    hostNames: runHostIds(s).map(nameOf),
    ...(s.task !== undefined ? { task: s.task } : {}),
    ...(s.scope !== undefined ? { scope: s.scope } : {}),
    ...(s.ticket !== undefined ? { ticket: s.ticket } : {}),
    ...(s.client !== undefined ? { client: s.client } : {}),
    ...(s.cliSessionId !== undefined ? { cliSessionId: s.cliSessionId } : {}),
    ...(s.resumesRunId !== undefined ? { resumesRunId: s.resumesRunId } : {}),
    ...(s.ok !== undefined ? { ok: s.ok } : {}),
    ...(s.aborted !== undefined ? { aborted: s.aborted } : {}),
    calls: s.calls.length,
    ...(s.costUsd !== undefined ? { costUsd: s.costUsd } : {}),
    ...(notes?.headline ? { headline: notes.headline } : {}),
    ...(notes?.findings ? { findings: notes.findings } : {}),
    ...(notes?.hypotheses ? { hypotheses: notes.hypotheses } : {}),
    ...(notes?.openHypotheses ? { openHypotheses: notes.openHypotheses } : {})
  }
}
