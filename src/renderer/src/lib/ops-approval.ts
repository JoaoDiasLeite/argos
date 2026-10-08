import type { ApprovalOpsContext, OpsPlanStep } from '../types'

/** Words joined by spaces; any word with whitespace or a quote is single-quoted. */
export function displayArgv(argv: string[]): string {
  return argv
    .map((w) => (w === '' || /[\s'"]/.test(w) ? `'${w.replace(/'/g, `'\''`)}'` : w))
    .join(' ')
}

/** Header verb and the "what exactly will run" lines for an ops approval. */
export function describeOpsRequest(ops: ApprovalOpsContext): { verb: string; lines: string[] } {
  const host = ops.hostName
  const path = ops.path ?? ''
  const argvLine = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ''
  const lines: string[] = []
  switch (ops.tool) {
    case 'plan':
      return { verb: `approve the plan for ${host}`, lines: (ops.planSteps ?? []).map((s) => s.title) }
    case 'host':
      return { verb: `reach ${host} for this intervention`, lines: [ops.hostAddress] }
    case 'script':
      if (argvLine) lines.push(argvLine)
      if (ops.scriptSha256) lines.push(`sha256 ${ops.scriptSha256.slice(0, 12)}…`)
      return { verb: `run script ${ops.argv?.[0] ?? ''} on ${host}`.replace('  ', ' '), lines }
    case 'read':
      return { verb: `read ${path} on ${host}`, lines: [path] }
    case 'list':
      return { verb: `list ${path} on ${host}`, lines: [path] }
    case 'write':
      return { verb: `write ${path} on ${host}`, lines: [path] }
    default:
      if (argvLine) lines.push(argvLine)
      return { verb: `run a command on ${host}`, lines }
  }
}

/** One-line toast summary, capped at ~80 chars. */
export function summarizeOps(ops: ApprovalOpsContext): string {
  if (ops.tool === 'plan') {
    const n = ops.planSteps?.length ?? 0
    return `Plan: ${n} step${n === 1 ? '' : 's'} for ${ops.hostName}`
  }
  if (ops.tool === 'host') return `Reach ${ops.hostName}?`
  const what = ops.argv && ops.argv.length ? displayArgv(ops.argv) : ops.path || ops.tool
  const full = `${ops.hostName}: ${what}`
  return full.length > 80 ? full.slice(0, 79) + '…' : full
}

const cap = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s)

/**
 * The toast's wording for an ops request: a question a person can answer at a glance
 * from outside the app, and one line of detail. Never the raw `mcp__ops__*` tool name.
 */
export function opsToastText(ops: ApprovalOpsContext): { title: string; detail: string } {
  const host = ops.hostName
  if (ops.tool === 'plan') {
    const t = planTotals(ops)
    return {
      title: `Approve the plan for ${ops.runbook || host}`,
      detail: `${t.total} step${t.total === 1 ? '' : 's'} · ${planChangesLine(t)}`
    }
  }
  const detail = ops.title || ops.reason
  const path = ops.path ?? ''
  switch (ops.tool) {
    case 'host':
      return { title: cap(`Allow reaching ${host} for this intervention?`, 90), detail: ops.reason }
    case 'script':
      return { title: cap(`Allow script ${ops.argv?.[0] ?? ''} on ${host}?`, 90), detail }
    case 'read':
      return { title: cap(`Allow reading ${path} on ${host}?`, 90), detail }
    case 'list':
      return { title: cap(`Allow listing ${path} on ${host}?`, 90), detail }
    case 'write':
      return { title: cap(`Allow writing ${path} on ${host}?`, 90), detail }
    default:
      return {
        title: ops.argv?.length ? `Allow \`${cap(displayArgv(ops.argv), 60)}\` on ${host}?` : `Allow a command on ${host}?`,
        detail
      }
  }
}

/**
 * The toast's question in pieces (board F2): words around one mono chip, the command or
 * path the operator is asked about. A plan or a host has no chip.
 */
export function opsToastQuestion(ops: ApprovalOpsContext): { lead: string; code?: string; tail: string } {
  const host = ops.hostName
  const argv = ops.argv?.length ? cap(displayArgv(ops.argv), 70) : ''
  const path = ops.path ? cap(ops.path, 70) : ''
  switch (ops.tool) {
    case 'plan': {
      const t = planTotals(ops)
      return { lead: `Approve the plan: ${t.total} step${t.total === 1 ? '' : 's'}, ${planChangesLine(t)}?`, tail: '' }
    }
    case 'host':
      return { lead: `The model wants to reach ${host}. Allow for this intervention?`, tail: '' }
    case 'script':
      return argv ? { lead: 'Allow script ', code: argv, tail: '?' } : { lead: 'Allow a script?', tail: '' }
    case 'read':
      return { lead: 'Allow reading ', code: path, tail: '?' }
    case 'list':
      return { lead: 'Allow listing ', code: path, tail: '?' }
    case 'write':
      return { lead: 'Allow writing ', code: path, tail: '?' }
    default:
      return argv ? { lead: 'Allow ', code: argv, tail: '?' } : { lead: 'Allow a command?', tail: '' }
  }
}

/** "Argos · diagnose-rails-host on rocky-test": the toast's eyebrow. */
export function opsToastEyebrow(ops: ApprovalOpsContext): string {
  const rb = ops.runbook
  if (ops.tool === 'plan') return rb ? `Argos · ${rb}` : 'Argos'
  return rb ? `Argos · ${rb} on ${ops.hostName}` : `Argos · ${ops.hostName}`
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
export function planTotalsGroups(t: PlanTotals): PlanTotalsGroup[] {
  const out: PlanTotalsGroup[] = []
  if (t.runs) out.push({ kind: 'runs', n: t.runs, text: t.runs === 1 ? 'runs on its own' : 'run on their own' })
  if (t.asks) out.push({ kind: 'asks', n: t.asks, text: 'will ask you first' })
  if (t.denied) out.push({ kind: 'denied', n: t.denied, text: 'not allowed' })
  return out
}

/** "nothing changes" or "2 change the host". */
export function planChangesLine(t: PlanTotals): string {
  if (t.mutates === 0) return 'nothing changes'
  return `${t.mutates} change${t.mutates === 1 ? 's' : ''} the host`
}

/** What the header names after "N steps": the one host every step names, else the runbook. */
export function planTarget(ops: ApprovalOpsContext): string {
  const hosts = new Set((ops.planSteps ?? []).map((s) => s.hostName).filter((h): h is string => !!h))
  if (hosts.size === 1) return `on ${[...hosts][0]}`
  return ops.runbook ? `runbook ${ops.runbook}` : `on ${ops.hostName}`
}

/** The small right-aligned label: `read`, `read · 3`, `asks · sudo`, `not allowed`. */
export function planStepLabel(step: OpsPlanStep): string {
  if (step.verdict === 'denied') return 'not allowed'
  if (step.verdict === 'asks') return step.sudo ? 'asks · sudo' : 'asks'
  if (step.verdict === 'unknown') return 'not classified'
  const base = step.class === 'mutate' ? 'changes' : 'read'
  return step.commands.length > 1 ? `${base} · ${step.commands.length}` : base
}
