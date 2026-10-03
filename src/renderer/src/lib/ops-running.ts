import { OPS_TERMINAL_PREFIX } from './ops-terminal'

/**
 * Which interventions are running, for the rail's indicator. An intervention is an ops
 * terminal whose pty outlives the workspace view, so the set is kept by App: the workspace
 * says a terminal came up, and App hears every terminal's exit itself, because by then the
 * workspace may not be mounted.
 *
 * Both updates hand back the same set when nothing changes, so a state setter given them
 * does not re-render the app for a chat's terminal exiting.
 */

export type OpsRunningSet = ReadonlySet<string>

export const isOpsTerminalId = (id: string): boolean => id.startsWith(OPS_TERMINAL_PREFIX)

/** `running` plus `id`, if it is an ops terminal. */
export function markOpsRunning(running: OpsRunningSet, id: string): OpsRunningSet {
  if (!isOpsTerminalId(id) || running.has(id)) return running
  return new Set(running).add(id)
}

/** `running` without `id`. */
export function markOpsEnded(running: OpsRunningSet, id: string): OpsRunningSet {
  if (!running.has(id)) return running
  const next = new Set(running)
  next.delete(id)
  return next
}

export interface OpsRunningSummary {
  count: number
  /** A running intervention has an approval waiting on the operator. */
  needsYou: boolean
}

/** What the rail shows: how many are running, and whether any is waiting on a decision. */
export function summarizeOpsRunning(
  running: OpsRunningSet,
  approvals: readonly { appSessionId: string; ops?: unknown }[]
): OpsRunningSummary {
  return {
    count: running.size,
    needsYou: approvals.some((a) => a.ops !== undefined && running.has(a.appSessionId))
  }
}
