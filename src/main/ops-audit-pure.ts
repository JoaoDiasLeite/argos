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
  OpsRunbookRef,
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
  planText?: string
  planDecision?: 'approved' | 'rejected'
  calls: OpsCallSummary[]
  ok?: boolean
  aborted?: boolean
  error?: string
  costUsd?: number
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
