import { useEffect, useMemo, useState } from 'react'
import type { OpsLiveEvent } from '../types'
import { foldOpsEvents, OPS_BAD_STATUSES, type OpsRow, type OpsRun } from '../lib/ops-timeline'
import { displayArgv } from '../lib/ops-approval'
import OpsReportModal from './OpsReportModal'
import './OpsTimeline.css'

// The live lines of every ops run seen since this module first loaded, per chat. Held at
// module level rather than in the component so closing the panel, or switching to another
// chat and back, does not lose a run's history: the subscription outlives any one mount.
// Runs from before this app start are not here; their reports still render from the ledger.
const buffers = new Map<string, OpsLiveEvent[]>()
const listeners = new Set<(appSessionId: string) => void>()
// Sessions whose ledger history was already merged into the buffer (or is being fetched).
const historyState = new Map<string, Promise<void>>()
let subscribed = false

const eventKey = (e: OpsLiveEvent): string =>
  `${e.line?.prev}|${e.line?.at}|${e.line?.event?.kind}|${e.line?.event?.callId ?? ''}`

/** Fetches the session's past ledger lines once and puts them BEFORE any live ones. */
function loadHistory(appSessionId: string): Promise<void> {
  let p = historyState.get(appSessionId)
  if (!p) {
    p = window.electronAPI.opsSessionEvents(appSessionId).then((res) => {
      if (!res.ok) return
      const seen = new Set(res.events.map(eventKey))
      const live = (buffers.get(appSessionId) ?? []).filter((e) => !seen.has(eventKey(e)))
      buffers.set(appSessionId, [...res.events, ...live])
      listeners.forEach((fn) => fn(appSessionId))
    }).catch(() => { historyState.delete(appSessionId) })
    historyState.set(appSessionId, p)
  }
  return p
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.electronAPI.onOpsEvent((data) => {
    if (!data || typeof data.appSessionId !== 'string') return
    const list = buffers.get(data.appSessionId) ?? []
    const key = eventKey(data)
    if (list.some((e) => eventKey(e) === key)) return
    buffers.set(data.appSessionId, [...list, data])
    listeners.forEach((fn) => fn(data.appSessionId))
  })
}

function useOpsEvents(appSessionId: string): { events: OpsLiveEvent[]; loading: boolean } {
  const [events, setEvents] = useState<OpsLiveEvent[]>(() => buffers.get(appSessionId) ?? [])
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    ensureSubscribed()
    setEvents(buffers.get(appSessionId) ?? [])
    let alive = true
    setLoading(true)
    void loadHistory(appSessionId).finally(() => { if (alive) setLoading(false) })
    const fn = (id: string) => { if (id === appSessionId) setEvents(buffers.get(appSessionId) ?? []) }
    listeners.add(fn)
    return () => { alive = false; listeners.delete(fn) }
  }, [appSessionId])
  return { events, loading }
}

interface Props {
  appSessionId: string
  runbookPath?: string
  onClose: () => void
}

const STATUS_LABEL: Record<OpsRow['status'], string> = {
  decided: 'decided',
  asked: 'waiting for approval',
  queued: 'queued',
  running: 'running',
  done: 'exit 0',
  denied: 'denied',
  failed: 'failed',
  'timed-out': 'timed out',
  stopped: 'stopped'
}

function formatDuration(ms?: number): string {
  if (ms == null) return ''
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function formatClock(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function statusText(row: OpsRow): string {
  if (row.status === 'failed') return row.exitCode == null ? 'failed (no exit code)' : `exit ${row.exitCode}`
  if (row.status === 'timed-out' && row.exitCode != null) return `timed out · exit ${row.exitCode}`
  return STATUS_LABEL[row.status]
}

function endedText(run: OpsRun): string {
  if (!run.ended) return 'running'
  const state = run.ended.aborted ? 'aborted' : run.ended.ok ? 'finished' : 'failed'
  return `${state} · $${run.ended.costUsd.toFixed(run.ended.costUsd < 0.01 ? 4 : 2)}`
}

function CallRow({ row }: { row: OpsRow }) {
  const [open, setOpen] = useState(false)
  const what = row.argv && row.argv.length ? displayArgv(row.argv) : row.path || row.tool || row.callId
  const bad = OPS_BAD_STATUSES.has(row.status)
  const hasOutput = !!(row.stdoutHead || row.stderrHead)
  return (
    <li className={`ops-tl-row${bad ? ' bad' : ''}`}>
      <div className="ops-tl-row-head">
        <span className="ops-tl-host">{row.host || '?'}</span>
        <span className="ops-tl-pills">
          {row.class && <span className={`ops-tl-pill class-${row.class}`}>{row.class}</span>}
          {row.decision && <span className={`ops-tl-pill decision-${row.decision}`}>{row.decision}</span>}
        </span>
      </div>
      <code className="ops-tl-what" title={row.title || row.reason}>{what}</code>
      <div className="ops-tl-status">
        <span className={`ops-tl-state state-${row.status}`}>{statusText(row)}</span>
        {row.durationMs != null && <span className="ops-tl-dur">{formatDuration(row.durationMs)}</span>}
        {hasOutput && (
          <button className="ops-tl-expand" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? 'Hide output' : 'Output'}
          </button>
        )}
      </div>
      {(row.status === 'denied' || row.reason === 'decided event missing') && row.reason && (
        <p className="ops-tl-reason">{row.reason}</p>
      )}
      {row.backup && <p className="ops-tl-reason">Backup: {row.backup.backupPath}</p>}
      {open && hasOutput && (
        <div className="ops-tl-output">
          {row.stdoutHead && <><span className="ops-tl-stream">stdout</span><pre>{row.stdoutHead}</pre></>}
          {row.stderrHead && <><span className="ops-tl-stream">stderr</span><pre>{row.stderrHead}</pre></>}
        </div>
      )}
    </li>
  )
}

/** Right-side panel of an ops chat: one block per run, newest first, one row per call. */
export default function OpsTimeline({ appSessionId, runbookPath, onClose }: Props) {
  const { events, loading } = useOpsEvents(appSessionId)
  const runs = useMemo(() => foldOpsEvents(events).reverse(), [events])
  const [reportRunId, setReportRunId] = useState<string | null>(null)

  return (
    <section className="ops-tl" aria-label="Ops timeline">
      <div className="ops-tl-heading">
        <strong>Ops</strong>
        <button className="btn-ghost small" onClick={onClose}>Close</button>
      </div>
      {loading && <p className="ops-tl-empty">Loading history…</p>}
      {!loading && runs.length === 0 && <p className="ops-tl-empty">No ops calls yet in this chat.</p>}
      {runs.map((run) => (
        <div key={run.runId} className="ops-tl-run">
          <div className="ops-tl-run-head">
            <div className="ops-tl-run-title">
              <strong>{run.runbook || 'Unknown runbook'}</strong>
              <span className={`ops-tl-run-state${run.ended && !run.ended.ok ? ' bad' : ''}`}>{endedText(run)}</span>
            </div>
            <div className="ops-tl-run-meta">
              {run.hosts.length > 0 && <span>{run.hosts.join(', ')}</span>}
              <span>{formatTime(run.startedAt)}</span>
            </div>
            {run.planDecision && (
              <div className={`ops-tl-plan ${run.planDecision}`}>
                {run.planDecision === 'approved' ? `Plan approved ${formatClock(run.planAt)}` : 'Plan rejected'}
              </div>
            )}
            {run.ended?.error && <p className="ops-tl-reason">{run.ended.error}</p>}
            {!run.ended && (
              <button className="btn-ghost small ops-tl-stop" onClick={() => { void window.electronAPI.stopAgent(appSessionId) }}>
                Stop run
              </button>
            )}
            {run.ended && (
              <button className="btn-ghost small ops-tl-report" onClick={() => setReportRunId(run.runId)}>
                Report
              </button>
            )}
          </div>
          {run.calls.length === 0 ? (
            <p className="ops-tl-empty">No calls in this run yet.</p>
          ) : (
            <ol className="ops-tl-calls">
              {run.calls.map((row) => <CallRow key={row.callId} row={row} />)}
            </ol>
          )}
        </div>
      ))}
      {reportRunId && (
        <OpsReportModal runId={reportRunId} runbookPath={runbookPath} onClose={() => setReportRunId(null)} />
      )}
    </section>
  )
}
