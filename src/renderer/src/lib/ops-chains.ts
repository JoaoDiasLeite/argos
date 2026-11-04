import type { OpsRunListItem } from '../types'

/** The runs of one resume chain: A, then the run that resumed A, and so on. */
export interface RunChain {
  /** Newest first. */
  runs: OpsRunListItem[]
  newest: OpsRunListItem
  oldest: OpsRunListItem
  sessions: number
  /** Tool calls over every run of the chain. */
  calls: number
  /** What the chain came to: the newest run's headline, else the first one any run has. */
  headline?: string
  task?: string
  hostName: string
  /** Hypotheses still open when the newest run ended. */
  openHypotheses: number
}

/**
 * Groups runs linked by `resumesRunId` (a run and the run that resumes it are one chain).
 * Chains come newest first by their newest run; inside a chain too. A run whose parent is not
 * on the list starts its own chain; a cycle is cut where it closes, so no run is dropped.
 */
export function chainsOf(runs: OpsRunListItem[]): RunChain[] {
  const byId = new Map(runs.map((r) => [r.runId, r]))
  const resumed = new Set<string>()
  for (const r of runs) {
    if (r.resumesRunId && byId.has(r.resumesRunId) && !resumed.has(r.resumesRunId)) resumed.add(r.resumesRunId)
  }
  const placed = new Set<string>()
  const walk = (tip: OpsRunListItem): OpsRunListItem[] => {
    const chain: OpsRunListItem[] = []
    for (let cur: OpsRunListItem | undefined = tip; cur && !placed.has(cur.runId); cur = cur.resumesRunId ? byId.get(cur.resumesRunId) : undefined) {
      placed.add(cur.runId)
      chain.push(cur)
    }
    return chain
  }
  const groups: OpsRunListItem[][] = []
  for (const tip of runs) if (!placed.has(tip.runId) && !resumed.has(tip.runId)) groups.push(walk(tip))
  // A cycle leaves its runs unplaced: keep them, each as it comes.
  for (const r of runs) if (!placed.has(r.runId)) groups.push(walk(r))

  const first = <T>(pick: (r: OpsRunListItem) => T | undefined, list: OpsRunListItem[]) => list.map(pick).find((v) => !!v)
  return groups
    .map((g): RunChain => {
      const newest = g[0]
      return {
        runs: g,
        newest,
        oldest: g[g.length - 1],
        sessions: g.length,
        calls: g.reduce((n, r) => n + r.calls, 0),
        headline: first((r) => r.headline?.trim() || undefined, g),
        task: newest.task || first((r) => r.task, g),
        hostName: newest.hostNames.join(', '),
        openHypotheses: newest.openHypotheses ?? 0
      }
    })
    .sort((a, b) => b.newest.startedAt.localeCompare(a.newest.startedAt))
}

/** A chain that ended with no call and no note anywhere (starts and stops): it says nothing. */
export function chainIsEmpty(c: RunChain): boolean {
  return c.runs.every((r) => !!r.endedAt && r.calls === 0 && !r.headline && !r.findings && !r.hypotheses)
}
