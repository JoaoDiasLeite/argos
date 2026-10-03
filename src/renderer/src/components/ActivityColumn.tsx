import { useEffect, useState, type ReactElement } from 'react'
import type { ApprovalOpsContext, ApprovalRequest } from '../types'
import { describeOpsRequest, displayArgv } from '../lib/ops-approval'
import { splitSections, type OpsOutputSection } from '../lib/ops-sections'
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

interface ScriptInfo {
  name: string
  title: string
  class: 'read' | 'mutate'
  hosts: { id: string; name: string }[]
  maxArgs: number
  argPattern?: string
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

/** One `== title ==` section of a script's output, folded until clicked. */
function SectionItem({ section, forceOpen }: { section: OpsOutputSection; forceOpen: boolean }) {
  const [open, setOpen] = useState(false)
  const shown = open || forceOpen
  return (
    <div className={`ac-sec${shown ? ' open' : ''}`}>
      <button type="button" className="ac-sec-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="ac-sec-caret" aria-hidden="true">{shown ? '▾' : '▸'}</span>
        <span className="ac-sec-title">{section.title || 'output'}</span>
        {!shown && section.body && <span className="ac-sec-peek">{section.body.split('\n')[0]}</span>}
      </button>
      {shown && <pre className="ac-sec-body">{section.body || '(no output)'}</pre>}
    </div>
  )
}

/** A script's output as one folded line per section, with an expand-all toggle. */
function SectionedOutput({ sections, stderr }: { sections: OpsOutputSection[]; stderr: string }) {
  const [all, setAll] = useState(false)
  return (
    <div className="ac-secs">
      <button type="button" className="ac-link ac-secs-all" onClick={() => setAll((v) => !v)}>
        {all ? 'Collapse all' : 'Expand all'}
      </button>
      {sections.map((s, i) => (
        <SectionItem key={`${i}:${s.title}`} section={s} forceOpen={all} />
      ))}
      {stderr && <pre className="ac-sec-body ac-sec-err">{stderr}</pre>}
    </div>
  )
}

function CallRow({ row }: { row: OpsRow }) {
  const [open, setOpen] = useState(false)
  const tone = rowTone(row)
  const output = [row.stdoutHead, row.stderrHead].filter(Boolean).join('\n')
  const sections = row.tool === 'script' && row.stdoutHead ? splitSections(row.stdoutHead) : null
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
      {open && output && (sections ? <SectionedOutput sections={sections} stderr={row.stderrHead ?? ''} /> : <pre className="ac-output">{output}</pre>)}
    </>
  )
}

/**
 * The runbook's scripts, one click each. The click is the operator's approval, so there is
 * no plan to wait for; the gate, any approval prompt and the ledger work as for the model.
 */
function ScriptsList({ terminalId, runId, disabled }: { terminalId: string; runId?: string; disabled: boolean }) {
  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ name: string; text: string } | null>(null)
  const [argText, setArgText] = useState<Record<string, string>>({})
  const [hostPick, setHostPick] = useState<Record<string, string>>({})

  useEffect(() => {
    let live = true
    // The session may open after this mounts, so ask again when the run appears.
    window.electronAPI
      .opsScripts(terminalId)
      .then((r) => {
        if (live && r.ok) setScripts(r.scripts)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [terminalId, runId])

  if (scripts.length === 0) return null

  const run = async (s: ScriptInfo): Promise<void> => {
    const hostId = hostPick[s.name] || s.hosts[0]?.id
    if (!hostId) return
    const raw = (argText[s.name] ?? '').trim()
    const args = s.maxArgs > 0 && raw ? raw.split(/\s+/) : []
    setBusy(s.name)
    setMessage(null)
    const r = await window.electronAPI.opsRunScript(terminalId, s.name, hostId, args)
    setBusy(null)
    // A success shows as a row below; only a refusal or failure needs words here.
    if (!r.ok) setMessage({ name: s.name, text: r.text ?? r.error ?? 'The script did not run.' })
  }

  return (
    <div className="ac-scripts">
      <div className="ac-scripts-head">Scripts</div>
      {scripts.map((s) => (
        <div key={s.name} className="ac-script">
          <div className="ac-script-main">
            <div className="ac-script-text">
              <span className="ac-script-title">{s.title}</span>
              <span className="ac-script-name">
                {s.name} · {s.class}
              </span>
            </div>
            {s.hosts.length > 1 && (
              <select
                className="ac-script-host"
                value={hostPick[s.name] || s.hosts[0].id}
                onChange={(e) => setHostPick({ ...hostPick, [s.name]: e.target.value })}
                aria-label={`Host for ${s.name}`}
              >
                {s.hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              className="ac-btn"
              disabled={disabled || busy !== null || s.hosts.length === 0}
              title={s.hosts.length === 0 ? 'No host of this intervention is in the script’s host groups' : `Run ${s.name}`}
              onClick={() => void run(s)}
            >
              {busy === s.name ? 'Running…' : 'Run'}
            </button>
          </div>
          {s.maxArgs > 0 && (
            <input
              className="ac-script-args"
              placeholder={`arguments (up to ${s.maxArgs})`}
              value={argText[s.name] ?? ''}
              onChange={(e) => setArgText({ ...argText, [s.name]: e.target.value })}
            />
          )}
          {message?.name === s.name && <div className="ac-script-err">{message.text}</div>}
        </div>
      ))}
    </div>
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

      <ScriptsList terminalId={terminalId} runId={current?.runId} disabled={!!current?.ended || !!waiting} />

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
