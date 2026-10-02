import { useState, type ReactElement } from 'react'
import type { ApprovalOpsContext, ApprovalRequest } from '../types'
import { describeOpsRequest, displayArgv } from '../lib/ops-approval'
import { planProgress, rowLabel, rowTone, type OpsHostAnswer, type OpsRow, type OpsRun } from '../lib/ops-timeline'
import PlanReviewSheet from './PlanReviewSheet'
import OpsReportSheet from './OpsReportSheet'
import './ActivityColumn.css'

interface Props {
  /** The workspace's terminal id: the ops session the runs belong to. */
  terminalId: string
  runbookPath: string
  /** The run of the CLI on screen; undefined until its first ledger line arrives. */
  current?: OpsRun
  /** Runs of this terminal before the current one, newest first. */
  earlier: OpsRun[]
  loading: boolean
  /** The approval waiting on this terminal, if any (App owns the queue). */
  waiting?: ApprovalRequest
  onDecide?: (allow: boolean, skipSteps?: number[]) => void
  /** Deny the waiting request and stop the run. */
  onDenyStop?: () => void
}

const clock = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const sameDay = (iso: string, now: Date): boolean => {
  const d = new Date(iso)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

/** The command, or `read <path>` for a file tool. */
const rowText = (r: OpsRow): string =>
  r.argv && r.argv.length ? displayArgv(r.argv) : r.path ? `${r.tool || 'read'} ${r.path}` : r.tool || r.callId

function runState(run: OpsRun): string {
  if (!run.ended) return `Running since ${clock(run.startedAt)}`
  if (run.ended.aborted) return 'Stopped'
  return `Finished ${clock(run.endedAt)}`
}

function earlierState(run: OpsRun): string {
  if (!run.ended) return 'not closed'
  return run.ended.aborted ? 'stopped' : run.ended.ok ? 'finished' : 'failed'
}

function CallRow({ row }: { row: OpsRow }) {
  const [open, setOpen] = useState(false)
  const tone = rowTone(row)
  const output = [row.stdoutHead, row.stderrHead].filter(Boolean).join('\n')
  const refused = row.status === 'denied' || row.status === 'stopped'
  const text = rowText(row)
  const label = rowLabel(row)
  const cls = `ac-row${open ? ' open' : ''}${refused ? ' refused' : ''}${output ? ' has-output' : ''}`
  const inner = (
    <>
      <span className={`ac-dot ${tone}${row.status === 'running' ? ' pulse' : ''}`} aria-hidden="true" />
      <span className="ac-cmd" title={[text, row.title, row.reason].filter(Boolean).join('\n')}>
        {text}
      </span>
      <span className={`ac-label ${tone}`}>{label}</span>
    </>
  )
  return (
    <>
      {output ? (
        <button type="button" className={cls} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {inner}
        </button>
      ) : (
        <div className={cls}>{inner}</div>
      )}
      {open && output && <pre className="ac-output">{output}</pre>}
    </>
  )
}

function HostLine({ answer }: { answer: OpsHostAnswer }) {
  return (
    <div className={`ac-hostline ${answer.answer}`}>
      Host {answer.host} {answer.answer === 'approved' ? 'allowed' : 'refused'} {clock(answer.at)}
    </div>
  )
}

/** The call or host variant of the waiting block. */
function WaitingCall({ ops, onDecide }: { ops: ApprovalOpsContext; onDecide: (allow: boolean) => void }) {
  if (ops.tool === 'host') {
    return (
      <>
        <div className="ac-wait-head">
          <span className="ac-wait-eyebrow">Waiting for you</span>
          <span className="ac-wait-tag">new host</span>
        </div>
        <div className="ac-wait-title">
          The model wants to reach <strong>{ops.hostName}</strong>. Allow for this intervention?
        </div>
        <div className="ac-wait-cmd">{ops.hostAddress}</div>
        <div className="ac-wait-actions">
          <button type="button" className="ac-allow" onClick={() => onDecide(true)}>
            Allow
          </button>
          <button type="button" className="ac-deny" onClick={() => onDecide(false)}>
            Deny
          </button>
        </div>
      </>
    )
  }
  const { verb, lines } = describeOpsRequest(ops)
  const sudo = ops.argv?.[0] === 'sudo'
  const title = ops.title || verb.charAt(0).toUpperCase() + verb.slice(1)
  return (
    <>
      <div className="ac-wait-head">
        <span className="ac-wait-eyebrow">Waiting for you</span>
        <span className="ac-wait-tag">{sudo ? 'sudo' : ops.class === 'mutate' ? 'changes the host' : 'read'}</span>
      </div>
      <div className="ac-wait-title">{title}</div>
      {lines.length > 0 && <div className="ac-wait-cmd">{lines.join('\n')}</div>}
      {sudo && ops.reason && <div className="ac-wait-reason">{ops.reason}</div>}
      {ops.queuedBehind > 0 && (
        <div className="ac-wait-reason">
          Queued behind {ops.queuedBehind} call{ops.queuedBehind === 1 ? '' : 's'} on {ops.hostName}.
        </div>
      )}
      <div className="ac-wait-actions">
        <button type="button" className="ac-allow" onClick={() => onDecide(true)}>
          Allow
        </button>
        <button type="button" className="ac-deny" onClick={() => onDecide(false)}>
          Deny
        </button>
      </div>
    </>
  )
}

/**
 * The Ops workspace's one activity column (docs/INTERVENTIONS_PLAN.md §4, board D2): the
 * run header, whatever waits for the operator as the only highlighted block, one line per
 * call, and the earlier runs of this intervention folded to a line each.
 */
export default function ActivityColumn({ terminalId, runbookPath, current, earlier, loading, waiting, onDecide, onDenyStop }: Props) {
  const [reportRunId, setReportRunId] = useState<string | null>(null)
  const progress = current ? planProgress(current) : null
  const today = new Date()
  const earlierToday = earlier.filter((r) => sameDay(r.startedAt, today))
  const running = !!current && !current.ended
  const ops = waiting?.ops

  // Host lines sit among the rows at the point the answer came.
  const rows: ReactElement[] = []
  if (current) {
    const answers = [...current.hostAnswers]
    current.calls.forEach((row, i) => {
      while (answers.length && answers[0].beforeCall <= i) {
        const a = answers.shift() as OpsHostAnswer
        rows.push(<HostLine key={`h:${a.hostId}:${a.at}`} answer={a} />)
      }
      rows.push(<CallRow key={row.callId} row={row} />)
    })
    for (const a of answers) rows.push(<HostLine key={`h:${a.hostId}:${a.at}`} answer={a} />)
  }

  return (
    <aside className="ac" aria-label="Activity">
      <div className="ac-run">
        <div className="ac-run-line">
          <span className="ac-run-state">{current ? runState(current) : loading ? 'Loading…' : 'Starting the run…'}</span>
          {progress && (
            <span className="ac-run-steps">
              {progress.done} of {progress.total} step{progress.total === 1 ? '' : 's'}
            </span>
          )}
        </div>
        {progress && (
          <div className="ac-progress" aria-hidden="true">
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        )}
        {current?.ended?.error && <div className="ac-run-error">{current.ended.error}</div>}
        <div className="ac-run-actions">
          <button type="button" className="ac-btn" disabled={!current} onClick={() => current && setReportRunId(current.runId)}>
            Report
          </button>
          <button
            type="button"
            className="ac-btn stop"
            disabled={!running}
            onClick={() => void window.electronAPI.opsStop(terminalId)}
            title="Stop this run: pending calls are refused and the CLI's ops tools stop working"
          >
            Stop
          </button>
        </div>
      </div>

      {waiting && ops && onDecide && (
        <div className="ac-wait-wrap">
          <div className={`ac-wait${ops.tool === 'plan' ? ' plan' : ''}`}>
            {ops.tool === 'plan' ? (
              <PlanReviewSheet key={waiting.approvalId} request={waiting} onDecide={onDecide} />
            ) : (
              <WaitingCall key={waiting.approvalId} ops={ops} onDecide={onDecide} />
            )}
          </div>
          {onDenyStop && (
            <button type="button" className="ac-denystop" onClick={onDenyStop}>
              Deny and stop
            </button>
          )}
        </div>
      )}

      <div className="ac-list">
        {current && rows.length === 0 && <p className="ac-empty">No calls yet. The model reads the runbook first.</p>}
        {rows}

        {earlierToday.length > 0 && (
          <>
            <div className="ac-divider">
              <span>
                Earlier today · {earlierToday.length} run{earlierToday.length === 1 ? '' : 's'}
              </span>
            </div>
            {earlierToday.map((r) => (
              <div key={r.runId} className="ac-earlier">
                <span>
                  {clock(r.startedAt)} · {earlierState(r)} · {r.calls.length} call{r.calls.length === 1 ? '' : 's'}
                </span>
                <span className="ac-muted">${(r.ended?.costUsd ?? 0).toFixed(2)}</span>
                <button type="button" className="ac-link" onClick={() => setReportRunId(r.runId)}>
                  Report
                </button>
              </div>
            ))}
          </>
        )}
      </div>

      {reportRunId && (
        <OpsReportSheet runId={reportRunId} appSessionId={terminalId} runbookPath={runbookPath} onClose={() => setReportRunId(null)} />
      )}
    </aside>
  )
}
