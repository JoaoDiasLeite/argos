/**
 * The intervention's scope (docs/INTERVENTIONS_PLAN.md §2, §3): which hosts one run may
 * touch, the operator's once-per-host answer in an open intervention, and the first
 * message the CLI is given. Pure: ops-session.ts applies these in its decision.
 */
import { lisbonDate } from './ops-handover-pure'
import type { ApprovalOpsContext } from './ops-run-pure'
import type { OpsScope } from './ops-types'

export type ScopeVerdict = 'allow' | 'ask' | 'deny'

/** Why a call on another host than the locked one is refused. */
export const outOfScopeReason = (hostName: string): string => `outside this intervention's scope: ${hostName}`

/** Why a host the operator refused stays refused for the rest of the run. */
export const hostDeniedReason = (hostName: string): string => `the operator refused ${hostName} for this intervention`

/** What the host prompt says it is for. */
export const HOST_ASK_REASON = 'first use of this host in an open intervention'

/**
 * The scope's say on one call, before the gate's. A host scope allows only its own host;
 * an open scope asks the first time a host is seen, then keeps the operator's answer for
 * the run. A host outside the policy is not this function's business: the gate refuses it.
 */
export function scopeVerdict(
  scope: OpsScope,
  hostId: string,
  approvedHosts: ReadonlySet<string>,
  deniedHosts: ReadonlySet<string> = new Set()
): ScopeVerdict {
  if (scope.kind === 'host') return hostId === scope.hostId ? 'allow' : 'deny'
  if (deniedHosts.has(hostId)) return 'deny'
  return approvedHosts.has(hostId) ? 'allow' : 'ask'
}

/** The approval context of a host's first touch in an open intervention. */
export function hostApprovalContext(host: { name: string }, hostAddress: string, runbookName: string): ApprovalOpsContext {
  return {
    hostName: host.name,
    hostAddress,
    tool: 'host',
    class: 'read',
    reason: HOST_ASK_REASON,
    queuedBehind: 0,
    runbook: runbookName
  }
}

/**
 * The CLI's first message: fixed text, then the operator's task on one line (a terminal
 * takes one line at a time; a newline would submit half of it). Without a task the model
 * reads the runbook and waits for the operator. A read-only runbook needs no plan, so its
 * lead does not mention one.
 *
 * A resumed intervention (INTERVENTION_HISTORY_PLAN §4) is a new run. With its Claude
 * conversation (`resume.conversation`), the model already holds the runbook and the
 * task, so the message says what did not carry over: the earlier plan approval and tool
 * connection. Without it, the model remembers nothing: it reads the earlier run's
 * briefing through past_interventions first, then starts as any run does. Related runs
 * are named the same way, before the task; their ids are all the message carries, the
 * briefings travel through the tool.
 */
export function interventionPrompt(
  task: string,
  opts: {
    planRequired?: boolean
    resume?: { runId: string; conversation: boolean }
    related?: string[]
    /** The runbook runs added to the base intervention, whose folder this is. */
    baseDir?: string
  } = {}
): string {
  const line = oneLine(task)
  const resume = opts.resume
  const related = [...new Set((opts.related ?? []).filter((id) => id && id !== resume?.runId))]
  const relatedText = related.length
    ? `Related earlier interventions: ${related.join(', ')}. Call past_interventions for each before you start.`
    : ''

  if (resume?.conversation) {
    const gate = opts.planRequired === false ? 'carry on' : 'propose a new plan before any other ops call'
    return [
      `This is a new Argos run resuming the intervention above (earlier run ${resume.runId}). Its plan approval and tool connection ended with it: ${gate}.`,
      relatedText,
      line
    ]
      .filter(Boolean)
      .join(' ')
  }

  // A runbook added to the base: the base's guidelines first, the runbook's on top of them.
  const read = opts.baseDir
    ? `Read the base intervention's RUNBOOK.md in ${opts.baseDir}, then RUNBOOK.md in this folder, which adds to it and wins where it is stricter,`
    : 'Read RUNBOOK.md in this folder'
  const lead = opts.planRequired === false ? `${read} before you start` : `${read} before proposing a plan`
  const base = line ? `${lead}, then: ${line}` : `${lead}, then wait for instructions.`
  const resumeText = resume ? `This intervention resumes run ${resume.runId}. Call past_interventions with that runId first.` : ''
  return [resumeText, relatedText, base].filter(Boolean).join(' ')
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** How much of an earlier run's task the operator's reference line repeats. */
const REFERENCE_TASK_CHARS = 200

/**
 * The line the operator's "Refer to an intervention" types into a live run's CLI: the
 * earlier run's id, its day and its task, and what to do with it. One line (a newline
 * would submit half of it); the briefing itself travels through past_interventions.
 */
export function referenceLine(ref: { runId: string; startedAt: string; task?: string }): string {
  // The day the operator lived the run on, as the briefing names it.
  const date = lisbonDate(ref.startedAt)
  const task = oneLine(ref.task ?? '')
  const cut = task.length > REFERENCE_TASK_CHARS ? `${task.slice(0, REFERENCE_TASK_CHARS - 1).trimEnd()}…` : task
  const about = cut ? `${date}, ${cut}` : date
  return `The operator points you to the earlier intervention ${ref.runId} (${about}). Call past_interventions with that runId and take it into account.`
}
