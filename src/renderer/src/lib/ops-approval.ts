import type { ApprovalOpsContext, OpsPlanStep } from '../types'
import { makeT, plural, type TFunction } from '../../../shared/i18n'

// Every text helper takes the translator last and defaults to English, so a caller that
// has not been given `t` yet (the toast window, for one) keeps compiling and reading as before.
const EN = makeT('en')

/** Words joined by spaces; any word with whitespace or a quote is single-quoted. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((w) => (w === '' || /[\s'"]/.test(w) ? `'${w.replace(/'/g, `'\''`)}'` : w))
    .join(' ')
}

/** Header verb and the "what exactly will run" lines for an ops approval. */
export function describeOpsRequest(ops: ApprovalOpsContext, t: TFunction = EN): { verb: string; lines: string[] } {
  const host = ops.hostName
  const path = ops.path ?? ''
  const argvLine = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ''
  const lines: string[] = []
  switch (ops.tool) {
    case 'plan':
      return { verb: t('ops.approval.verb.plan', { host }), lines: (ops.planSteps ?? []).map((s) => s.title) }
    case 'host':
      return { verb: t('ops.approval.verb.host', { host }), lines: [ops.hostAddress] }
    case 'script':
      if (argvLine) lines.push(argvLine)
      if (ops.scriptSha256) lines.push(`sha256 ${ops.scriptSha256.slice(0, 12)}…`)
      return { verb: t('ops.approval.verb.script', { script: ops.argv?.[0] ?? '', host }).replace('  ', ' '), lines }
    case 'read':
      return { verb: t('ops.approval.verb.read', { path, host }), lines: [path] }
    case 'list':
      return { verb: t('ops.approval.verb.list', { path, host }), lines: [path] }
    case 'write':
      return { verb: t('ops.approval.verb.write', { path, host }), lines: [path] }
    default:
      if (argvLine) lines.push(argvLine)
      return { verb: t('ops.approval.verb.run', { host }), lines }
  }
}

/** One-line toast summary, capped at ~80 chars. */
export function summarizeOps(ops: ApprovalOpsContext, t: TFunction = EN): string {
  if (ops.tool === 'plan') {
    const n = ops.planSteps?.length ?? 0
    return plural(t, 'ops.approval.summary.plan', n, { host: ops.hostName })
  }
  if (ops.tool === 'host') return t('ops.approval.summary.host', { host: ops.hostName })
  const what = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ops.path || ops.tool
  const full = `${ops.hostName}: ${what}`
  return full.length > 80 ? full.slice(0, 79) + '…' : full
}

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * The toast's wording for an ops request: a question a person can answer at a glance
 * from outside the app, and one line of detail. Never the raw `mcp__ops__*` tool name.
 */
export function opsToastText(ops: ApprovalOpsContext, t: TFunction = EN): { title: string; detail: string } {
  const host = ops.hostName
  if (ops.tool === 'plan') {
    const totals = planTotals(ops)
    return {
      title: t('ops.approval.toast.plan', { name: ops.runbook || host }),
      detail: t('ops.approval.toast.planDetail', {
        steps: plural(t, 'ops.approval.steps', totals.total),
        changes: planChangesLine(totals, t)
      })
    }
  }
  const detail = ops.title || ops.reason
  const path = ops.path ?? ''
  switch (ops.tool) {
    case 'host':
      return { title: cap(t('ops.approval.toast.host', { host }), 90), detail: ops.reason }
    case 'script':
      return { title: cap(t('ops.approval.toast.script', { script: ops.argv?.[0] ?? '', host }), 90), detail }
    case 'read':
      return { title: cap(t('ops.approval.toast.read', { path, host }), 90), detail }
    case 'list':
      return { title: cap(t('ops.approval.toast.list', { path, host }), 90), detail }
    case 'write':
      return { title: cap(t('ops.approval.toast.write', { path, host }), 90), detail }
    default:
      return {
        title: ops.argv?.length
          ? t('ops.approval.toast.command', { command: cap(displayArgv(ops.argv), 60), host })
          : t('ops.approval.toast.anyCommand', { host }),
        detail
      }
  }
}

/**
 * The toast's question in pieces (board F2): words around one mono chip, the command or
 * path the operator is asked about. A plan or a host has no chip.
 */
export function opsToastQuestion(ops: ApprovalOpsContext, t: TFunction = EN): { lead: string; code?: string; tail: string } {
  const host = ops.hostName
  const argv = ops.argv?.length ? cap(displayArgv(ops.argv), 70) : ''
  const path = ops.path ? cap(ops.path, 70) : ''
  switch (ops.tool) {
    case 'plan': {
      const totals = planTotals(ops)
      return {
        lead: t('ops.approval.question.plan', {
          steps: plural(t, 'ops.approval.steps', totals.total),
          changes: planChangesLine(totals, t)
        }),
        tail: ''
      }
    }
    case 'host':
      return { lead: t('ops.approval.question.host', { host }), tail: '' }
    case 'script':
      return argv
        ? { lead: t('ops.approval.question.scriptLead'), code: argv, tail: t('ops.approval.question.tail') }
        : { lead: t('ops.approval.question.anyScript'), tail: '' }
    case 'read':
      return { lead: t('ops.approval.question.readLead'), code: path, tail: t('ops.approval.question.tail') }
    case 'list':
      return { lead: t('ops.approval.question.listLead'), code: path, tail: t('ops.approval.question.tail') }
    case 'write':
      return { lead: t('ops.approval.question.writeLead'), code: path, tail: t('ops.approval.question.tail') }
    default:
      return argv
        ? { lead: t('ops.approval.question.commandLead'), code: argv, tail: t('ops.approval.question.tail') }
        : { lead: t('ops.approval.question.anyCommand'), tail: '' }
  }
}

/** "Argos · diagnose-rails-host on rocky-test": the toast's eyebrow. */
export function opsToastEyebrow(ops: ApprovalOpsContext, t: TFunction = EN): string {
  const rb = ops.runbook
  if (ops.tool === 'plan') return rb ? t('ops.approval.eyebrow.plan', { runbook: rb }) : 'Argos'
  return rb
    ? t('ops.approval.eyebrow.runbookOnHost', { runbook: rb, host: ops.hostName })
    : t('ops.approval.eyebrow.host', { host: ops.hostName })
}

// ── Plan review sheet ──

export interface PlanTotals {
  runs: number
  asks: number
  denied: number
  mutates: number
  /** Steps in none of the three buckets (the gate could not classify them). */
  unknown: number
  total: number
}

/** The plan's totals: the gate's summary when it sent one, else counted from the steps. */
export function planTotals(ops: ApprovalOpsContext): PlanTotals {
  const steps = ops.planSteps ?? []
  const counted = { runs: 0, asks: 0, denied: 0, mutates: 0 }
  for (const s of steps) {
    if (s.verdict === 'runs') counted.runs++
    else if (s.verdict === 'asks') counted.asks++
    else if (s.verdict === 'denied') counted.denied++
    if (s.class === 'mutate') counted.mutates++
  }
  const { runs, asks, denied, mutates } = ops.planSummary ?? counted
  const total = steps.length
  return { runs, asks, denied, mutates, unknown: Math.max(0, total - runs - asks - denied), total }
}

/**
 * The totals of the steps that will run: every step when none is skipped (the gate's
 * summary still wins then), else counted from the steps left.
 */
export function planTotalsWithout(ops: ApprovalOpsContext, skipped: ReadonlySet<number>): PlanTotals {
  if (skipped.size === 0) return planTotals(ops)
  return planTotals({ ...ops, planSummary: undefined, planSteps: (ops.planSteps ?? []).filter((_, i) => !skipped.has(i)) })
}

export interface PlanTotalsGroup {
  kind: 'runs' | 'asks' | 'denied'
  n: number
  text: string
}

/** "5 run on their own · 2 will ask you first · 1 not allowed", zero groups left out. */
export function planTotalsGroups(t: PlanTotals, tr: TFunction = EN): PlanTotalsGroup[] {
  const out: PlanTotalsGroup[] = []
  if (t.runs) out.push({ kind: 'runs', n: t.runs, text: tr(t.runs === 1 ? 'ops.approval.group.runsOne' : 'ops.approval.group.runsMany') })
  if (t.asks) out.push({ kind: 'asks', n: t.asks, text: tr('ops.approval.group.asks') })
  if (t.denied) out.push({ kind: 'denied', n: t.denied, text: tr('ops.approval.group.denied') })
  return out
}

/** "nothing changes" or "2 change the host". */
export function planChangesLine(t: PlanTotals, tr: TFunction = EN): string {
  if (t.mutates === 0) return tr('ops.approval.changes.none')
  return plural(tr, 'ops.approval.changes', t.mutates)
}

/** What the header names after "N steps": the one host every step names, else the runbook. */
export function planTarget(ops: ApprovalOpsContext, t: TFunction = EN): string {
  const hosts = new Set((ops.planSteps ?? []).map((s) => s.hostName).filter((h): h is string => !!h))
  if (hosts.size === 1) return t('ops.approval.target.host', { host: [...hosts][0] })
  return ops.runbook
    ? t('ops.approval.target.runbook', { runbook: ops.runbook })
    : t('ops.approval.target.host', { host: ops.hostName })
}

/** The small right-aligned label: `read`, `read · 3`, `asks · sudo`, `not allowed`. */
export function planStepLabel(step: OpsPlanStep, t: TFunction = EN): string {
  if (step.verdict === 'denied') return t('ops.approval.step.denied')
  if (step.verdict === 'asks') return step.sudo ? t('ops.approval.step.asksSudo') : t('ops.approval.step.asks')
  if (step.verdict === 'unknown') return t('ops.approval.step.unknown')
  const base = step.class === 'mutate' ? t('ops.approval.step.changes') : t('ops.approval.step.read')
  return step.commands.length > 1 ? t('ops.approval.step.withCount', { label: base, n: step.commands.length }) : base
}
