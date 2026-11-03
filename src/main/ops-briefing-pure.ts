/**
 * What the model reads about an earlier intervention through `past_interventions`
 * (docs/INTERVENTION_HISTORY_PLAN.md §2, §3): a briefing of one run, or the list of runs
 * in scope. English, like everything the model reads, and built from the ledger only, so
 * it holds nothing the ledger does not (no output of the model's own calls, no secrets).
 *
 * The briefing is capped at BRIEFING_MAX_BYTES: it is a tool result the model pays for on
 * every turn after, and a resumed run needs the conclusions, not the transcript. Sections
 * go from most to least useful, so a cut drops the oldest calls first.
 */

import { summarizeRun, type OpsCallSummary, type OpsLinkedRun, type OpsRunListItem, type OpsRunSummary } from './ops-audit-pure'
import { lisbonDate } from './ops-handover-pure'
import { foldNotes } from './ops-notes-pure'
import type { OpsAuditLine, OpsScope } from './ops-types'

export const BRIEFING_MAX_BYTES = 8 * 1024
/** The most recent calls a briefing lists. */
export const BRIEFING_MAX_CALLS = 40
/** How much of an operator's pasted output a briefing keeps. */
export const BRIEFING_OUTPUT_CHARS = 300
/** Ancestors (runs the briefed run itself resumed) named, one line each. */
export const BRIEFING_MAX_ANCESTORS = 3
/** The most runs past_interventions lists. */
export const HISTORY_LIST_MAX = 15
/** A run id as past_interventions takes it (the same shape the ledger's run ids have). */
export const HISTORY_RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** A command longer than this is cut: a briefing names what ran, it does not replay it. */
const COMMAND_CHARS = 300

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Cut to `max` characters, saying so. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()}… [cut]`
}

/** `YYYY-MM-DD HH:MM` in Lisbon time, the clock the operator lived the run on. */
function lisbonStamp(iso: string): string {
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Lisbon', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso))
  return `${lisbonDate(iso)} ${time}`
}

function startOf(lines: OpsAuditLine[]): string | undefined {
  const start = lines.find((l) => l.event.kind === 'run.start')
  return start?.event.runId
}

function outcome(s: { ok?: boolean; aborted?: boolean; error?: string; endedAt?: string }): string {
  if (s.ok === undefined && s.endedAt === undefined) return 'no end recorded (still running, or the app closed)'
  if (s.aborted) return `stopped by the operator${s.error ? ` (${oneLine(s.error)})` : ''}`
  if (s.ok) return 'finished'
  return `ended with an error${s.error ? `: ${oneLine(s.error)}` : ''}`
}

function hostNames(s: OpsRunSummary): string[] {
  if (s.scope?.kind === 'host') {
    const id = s.scope.hostId
    return [s.hosts.find((h) => h.id === id)?.name ?? id]
  }
  const touched = [...new Set(s.calls.map((c) => c.host || c.hostId).filter((h) => h !== ''))]
  return touched.length ? touched : s.hosts.map((h) => h.name)
}

function callText(c: OpsCallSummary): string {
  const raw = (c.rawInput && typeof c.rawInput === 'object' ? c.rawInput : {}) as Record<string, unknown>
  const path = c.path ?? (typeof raw.path === 'string' ? raw.path : '')
  switch (c.tool) {
    case 'run':
      return c.argv?.length ? c.argv.join(' ') : typeof raw.cmd === 'string' ? raw.cmd : '(command not recorded)'
    case 'script': {
      const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string') : []
      return `script ${[typeof raw.name === 'string' ? raw.name : '?', ...args].join(' ')}`
    }
    default:
      return `${c.tool} ${path}`
  }
}

/** What became of a call: the gate's or operator's verdict, then how it ended. */
function callResult(c: OpsCallSummary): string {
  if (c.decision === 'deny') return 'denied by policy'
  if (c.answer === 'deny') return 'refused by the operator'
  if (c.answer === 'stop') return 'run stopped at the prompt'
  const verdict = c.decision === 'ask' ? 'approved' : 'allowed'
  if (c.timedOut) return `${verdict}, timed out`
  if (c.exitCode === undefined) return `${verdict}, no finish recorded`
  if (c.exitCode === null) return `${verdict}, killed`
  return `${verdict}, exit ${c.exitCode}`
}

/** Keep whole lines under the byte cap, ending with a marker that says what was left out. */
function capBytes(lines: string[], max: number): string {
  const full = lines.join('\n') + '\n'
  if (Buffer.byteLength(full, 'utf-8') <= max) return full
  const kept: string[] = []
  let bytes = 0
  for (let i = 0; i < lines.length; i++) {
    const marker = `[briefing cut at ${Math.round(max / 1024)} KB: ${lines.length - i} more lines left out]`
    const next = Buffer.byteLength(lines[i] + '\n', 'utf-8')
    if (bytes + next + Buffer.byteLength(marker + '\n', 'utf-8') > max) {
      kept.push(marker)
      break
    }
    kept.push(lines[i])
    bytes += next
  }
  return kept.join('\n') + '\n'
}

/**
 * The briefing of one earlier run. `run` is that run's ledger lines; `ancestors` the lines
 * of the runs it itself resumed, nearest first (one line each, at most three). `opts.resumedBy`
 * names the runs that later resumed it, which its own lines cannot know.
 */
export function renderBriefing(run: OpsAuditLine[], ancestors: OpsAuditLine[][], opts: { resumedBy?: OpsLinkedRun[] } = {}): string {
  const runId = startOf(run)
  const s = runId ? summarizeRun(run, runId) : null
  if (!s) return 'This run has no start in the ledger, so there is nothing to brief.\n'
  const f = foldNotes(run, s.runId)

  const out: string[] = [`# Earlier intervention ${s.runId}`, '']
  out.push(`- When: ${lisbonStamp(s.startedAt)}${s.endedAt ? ` to ${lisbonStamp(s.endedAt)}` : ''} (Lisbon)`)
  const servers = hostNames(s)
  out.push(`- ${servers.length === 1 ? 'Server' : 'Servers'}: ${servers.length ? servers.join(', ') : 'none'}`)
  out.push(`- Runbook: ${s.runbook.name}`)
  if (s.task) out.push(`- Task: ${clip(oneLine(s.task), 500)}`)
  if (s.ticket) out.push(`- Ticket: ${oneLine(s.ticket)}`)
  if (s.client) out.push(`- Client: ${oneLine(s.client)}`)
  out.push(`- Outcome: ${outcome(s)}`)
  if (s.parentRunId) out.push(`- Followed diagnosis run ${s.parentRunId}`)
  if (s.resumesRunId) out.push(`- Resumed run ${s.resumesRunId}`)
  if (s.handover) out.push(`- Handed over to runbook ${s.handover.runbook}${s.handover.childRunId ? ` (run ${s.handover.childRunId})` : ''}`)
  for (const r of opts.resumedBy ?? []) out.push(`- Resumed later by run ${r.runId} (${lisbonStamp(r.startedAt)})`)

  const earlier = ancestors
    .map((lines) => {
      const id = startOf(lines)
      return id ? summarizeRun(lines, id) : null
    })
    .filter((a): a is OpsRunSummary => a !== null)
    .slice(0, BRIEFING_MAX_ANCESTORS)
  if (earlier.length) {
    out.push('', '## Earlier in this chain', '')
    for (const a of earlier) {
      const task = a.task ? `: ${clip(oneLine(a.task), 200)}` : ''
      out.push(`- ${a.runId} (${lisbonStamp(a.startedAt)}, ${a.runbook.name})${task}; ${outcome(a)}`)
    }
  }

  if (f.summary) out.push('', '## Summary', '', clip(f.summary.trim(), 1500))

  if (s.planSteps?.length) {
    out.push('', '## Approved plan', '')
    s.planSteps.forEach((p, i) => out.push(`${i + 1}. ${oneLine(p.title)}${p.hostName ? ` (${p.hostName})` : ''}${p.skipped ? ' (skipped)' : ''}`))
  } else if (s.planDecision === 'approved' && s.planText?.trim()) {
    out.push('', '## Approved plan', '', clip(s.planText.trim(), 1500))
  }

  if (f.hypotheses.length) {
    out.push('', '## Hypotheses (last status)', '')
    for (const h of f.hypotheses) out.push(`- [${h.status}] ${oneLine(h.text)}${h.evidence ? ` (evidence: ${oneLine(h.evidence)})` : ''}`)
  }

  if (f.findings.length) {
    out.push('', '## Findings', '')
    for (const n of f.findings) out.push(`- ${oneLine(n.text)}${n.evidence ? ` (evidence: ${oneLine(n.evidence)})` : ''}`)
  }

  if (f.actions.length) {
    out.push('', '## Recommended actions', '')
    for (const a of f.actions) out.push(`- [${a.when === 'later' ? 'later' : 'now'}] ${oneLine(a.text)}`)
  }

  if (f.asks.length) {
    out.push('', '## Operator requests', '')
    for (const a of f.asks) {
      const where = a.host ? ` on ${a.host}` : ''
      const answer = !a.answered
        ? 'no answer recorded'
        : a.answered.declined
          ? 'declined'
          : `answered: ${JSON.stringify(clip(a.answered.output ?? '', BRIEFING_OUTPUT_CHARS))}`
      out.push(`- \`${clip(oneLine(a.cmd), COMMAND_CHARS)}\`${where}: ${answer}`)
    }
  }

  // Last so the byte cap drops them first; newest last, as they ran.
  const calls = s.calls.slice(-BRIEFING_MAX_CALLS)
  out.push('', s.calls.length > calls.length ? `## Calls (last ${calls.length} of ${s.calls.length})` : `## Calls (${calls.length})`, '')
  if (!calls.length) out.push('None.')
  for (const c of calls) out.push(`- ${c.host || c.hostId || '?'}: \`${clip(oneLine(callText(c)), COMMAND_CHARS)}\` (${callResult(c)})`)

  return capBytes(out, BRIEFING_MAX_BYTES)
}

/** The history the model may read, one run per line, newest first as listRuns gives it. */
export function historyListText(items: OpsRunListItem[]): string {
  if (!items.length) return 'No earlier interventions on record for the hosts this run may reach.\n'
  const out = [`Earlier interventions in scope, newest first (${items.length}). Call past_interventions with a runId to read one.`, '']
  for (const r of items) {
    const end = r.ok === undefined && r.endedAt === undefined ? 'no end recorded' : r.aborted ? 'stopped' : r.ok ? 'finished' : 'error'
    const task = r.task ? clip(oneLine(r.task), 200) : '(no task)'
    const hosts = r.hostNames.length ? r.hostNames.join(', ') : 'no host'
    const resumed = r.resumesRunId ? `; resumed ${r.resumesRunId}` : ''
    out.push(`- ${r.runId} · ${lisbonStamp(r.startedAt)} · ${hosts} · ${r.runbook} · ${task} · ${end}, ${r.calls} calls${resumed}`)
  }
  return out.join('\n') + '\n'
}

/**
 * The hosts whose history this run may read (INTERVENTION_HISTORY_PLAN §2): the locked host
 * of a host scope, or every runbook host for an open scope or a run without one, since
 * those may reach any of them.
 */
export function historyScopeHosts(ctx: { scope?: OpsScope; hosts: { byId: Map<string, unknown> } }): string[] {
  if (ctx.scope?.kind === 'host') return [ctx.scope.hostId]
  return [...ctx.hosts.byId.keys()]
}

/**
 * Lists of runs (one per scope host, newest first each) merged into one newest-first list,
 * each run once, without `excludeRunId` (the run that asks).
 */
export function mergeRunLists(lists: OpsRunListItem[][], excludeRunId: string): OpsRunListItem[] {
  const byId = new Map<string, OpsRunListItem>()
  for (const list of lists) for (const r of list) if (r.runId !== excludeRunId && !byId.has(r.runId)) byId.set(r.runId, r)
  return [...byId.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
}

/** The runs in `items` (newest first) that resumed `runId`, oldest first as the briefing names them. */
export function resumedByOf(items: OpsRunListItem[], runId: string): OpsLinkedRun[] {
  return items
    .filter((r) => r.resumesRunId === runId)
    .reverse()
    .map((r) => ({ runId: r.runId, startedAt: r.startedAt, ...(r.task !== undefined ? { task: r.task } : {}) }))
}
