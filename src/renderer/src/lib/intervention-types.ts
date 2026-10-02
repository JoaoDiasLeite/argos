import type { OpsRunbookInfo } from '../types'

// TODO(A): these mirror the Batch A contract (ops:load-runbook's summary, ops:runs,
// ops:open-runbook-file, the intervention object). Replace them with the types A adds
// to types.ts, and drop the cast in `interventionApi`, once they land.

/** Which hosts an intervention may touch: one, locked; or any the runbook's policy knows. */
export type InterventionScope = { kind: 'host'; hostId: string } | { kind: 'open' }

/** What the start screen hands the workspace. */
export interface Intervention {
  runbookPath: string
  scope: InterventionScope
  task: string
  ticket?: string
  client?: string
}

/** `ops:load-runbook`'s plain-words summary of what the policy allows. */
export interface OpsRunbookSummary {
  autoReads: number
  asks: number
  mutates: number
  scripts: number
  readPaths: string[]
  guidelinesHead: string
}

/** One run of the ledger, as `ops:runs` lists it (newest first). */
export interface OpsRunSummary {
  runId: string
  appSessionId: string
  startedAt: string
  endedAt?: string
  runbook: string
  hostNames: string[]
  task?: string
  ok?: boolean
  aborted?: boolean
  calls: number
  costUsd?: number
}

export type OpsRunsResult = { ok: true; runs: OpsRunSummary[] } | { ok: false; error: string }

interface InterventionApi {
  opsRuns: (q: { hostId?: string; limit?: number }) => Promise<OpsRunsResult>
  opsOpenRunbookFile: (dir: string, file: 'RUNBOOK.md' | 'policy.json') => Promise<unknown>
}

/** The two IPC calls A adds, typed until types.ts declares them; a preload without them
 *  answers with an error instead of throwing. */
export function interventionApi(): InterventionApi {
  const api = window.electronAPI as unknown as Partial<InterventionApi>
  return {
    opsRuns: (q) =>
      api.opsRuns ? api.opsRuns(q) : Promise.resolve({ ok: false, error: 'Run history is not available in this build.' }),
    opsOpenRunbookFile: (dir, file) => (api.opsOpenRunbookFile ? api.opsOpenRunbookFile(dir, file) : Promise.resolve(undefined))
  }
}

/** The summary on a loaded runbook, when main sends one. */
export function runbookSummary(info: OpsRunbookInfo | undefined): OpsRunbookSummary | undefined {
  if (!info || !info.ok) return undefined
  return (info as { summary?: OpsRunbookSummary }).summary
}
