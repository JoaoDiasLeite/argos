/**
 * The model's `note` calls and the operator asks of one run, folded the way every reader
 * of a run needs them: the latest summary wins, a hypothesis keeps its first-seen place
 * but takes its latest text, status and evidence, and each ask carries its answer. Shared
 * by the handover (ops-handover-pure.ts) and the briefing (ops-briefing-pure.ts), so the
 * two never disagree about what a run concluded.
 */

import type { OpsAuditLine, OpsNote } from './ops-types'

export interface FoldedHypothesis {
  id: string
  text: string
  status: NonNullable<OpsNote['status']>
  evidence?: string
}

export interface FoldedAsk {
  askId: string
  cmd: string
  why: string
  host?: string
  answered?: { output?: string; declined?: true }
}

export interface FoldedNotes {
  summary?: string
  /** First-seen order; the latest note of each id gives its text, status and evidence. */
  hypotheses: FoldedHypothesis[]
  findings: OpsNote[]
  events: OpsNote[]
  actions: OpsNote[]
  asks: FoldedAsk[]
}

/** Fold `runId`'s notes and asks out of `lines`; lines of other runs are ignored. */
export function foldNotes(lines: OpsAuditLine[], runId: string): FoldedNotes {
  const f: FoldedNotes = { hypotheses: [], findings: [], events: [], actions: [], asks: [] }
  const byId = new Map<string, FoldedHypothesis>()
  const asks = new Map<string, FoldedAsk>()
  for (const { event: e } of lines) {
    if (e.runId !== runId) continue
    if (e.kind === 'note') {
      const n = e.note
      if (n.kind === 'summary') f.summary = n.text
      else if (n.kind === 'finding') f.findings.push(n)
      else if (n.kind === 'event') f.events.push(n)
      else if (n.kind === 'action') f.actions.push(n)
      else if (n.kind === 'hypothesis' && n.id) {
        const next: FoldedHypothesis = { id: n.id, text: n.text, status: n.status ?? 'open', ...(n.evidence ? { evidence: n.evidence } : {}) }
        const prev = byId.get(n.id)
        if (prev) Object.assign(prev, next, n.evidence ? {} : { evidence: prev.evidence })
        else {
          byId.set(n.id, next)
          f.hypotheses.push(next)
        }
      }
    } else if (e.kind === 'operator.asked') {
      const a: FoldedAsk = { askId: e.askId, cmd: e.cmd, why: e.why, ...(e.host ? { host: e.host } : {}) }
      asks.set(e.askId, a)
      f.asks.push(a)
    } else if (e.kind === 'operator.answered') {
      const a = asks.get(e.askId)
      if (a) a.answered = e.declined ? { declined: true } : { output: e.output ?? '' }
    }
  }
  return f
}
