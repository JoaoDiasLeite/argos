/**
 * What the out-of-window indicators (taskbar progress, the status pill, the attention
 * badge) should do when a terminal's CLI starts or stops working (docs/TERMINAL_ONLY_PLAN.md
 * H5). Until the SDK chat goes, its runs (`activeRuns`) count beside the busy terminals.
 *
 * Pure: index.ts holds the set and does the Electron calls.
 */

export type TerminalBusyChange =
  /** The terminal went busy: the run indicators turn on, the pill shows "running". */
  | { kind: 'started'; total: number }
  /** It went idle: flag success; `total` 0 means nothing else is working, so the pill says done. */
  | { kind: 'finished'; total: number }
  /** No transition (a repeat, or an idle report for a terminal that was not busy). */
  | { kind: 'none'; total: number }

/** How many things are working right now, the SDK runs and the busy terminals together. */
export function runIndicatorCount(activeRuns: number, busyTerminals: ReadonlySet<string>): number {
  return activeRuns + busyTerminals.size
}

/** Apply one `onBusy(id, busy)` to `set` and say what it changed. */
export function noteTerminalBusy(set: Set<string>, id: string, busy: boolean, activeRuns: number): TerminalBusyChange {
  const was = set.has(id)
  if (busy) set.add(id)
  else set.delete(id)
  const total = runIndicatorCount(activeRuns, set)
  if (busy && !was) return { kind: 'started', total }
  if (!busy && was) return { kind: 'finished', total }
  return { kind: 'none', total }
}
