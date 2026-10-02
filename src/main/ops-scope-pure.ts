/**
 * The intervention's scope (docs/INTERVENTIONS_PLAN.md §2, §3): which hosts one run may
 * touch, the operator's once-per-host answer in an open intervention, and the first
 * message the CLI is given. Pure: ops-session.ts applies these in its decision.
 */
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
 * reads the runbook and waits for the operator.
 */
export function interventionPrompt(task: string): string {
  const line = task.replace(/\s+/g, ' ').trim()
  const lead = 'Read RUNBOOK.md in this folder before proposing a plan'
  return line ? `${lead}, then: ${line}` : `${lead}, then wait for instructions.`
}
