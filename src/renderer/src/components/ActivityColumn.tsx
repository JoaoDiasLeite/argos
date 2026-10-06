import { useEffect, useState, type ReactElement } from 'react'
import type { ApprovalOpsContext, ApprovalRequest } from '../types'
import { describeOpsRequest, displayArgv } from '../lib/ops-approval'
import { splitSections, type OpsOutputSection } from '../lib/ops-sections'
import {
  currentStepKey,
  groupCallsBySteps,
  planProgress,
  rowLabel,
  rowTone,
  type OpsHostAnswer,
  type OpsRow,
  type OpsRowTone,
  type OpsRun,
  type OpsStepGroup
} from '../lib/ops-timeline'
import PlanReviewSheet from './PlanReviewSheet'
import OpsReportSheet from './OpsReportSheet'
import { backdropClose } from '../lib/backdrop-close'
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
  /** End the intervention: stop the run, close its CLI and leave the workspace. Without
   *  it, Stop only stops the run. */
  onStop?: () => void
  /** The CLI is still up, so there is something for onStop to end even after the run has. */
  cliAlive?: boolean
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

const TONE_RANK: Record<OpsRowTone, number> = { idle: 0, ok: 1, warn: 2, bad: 3 }

/** A step's folded line: how many calls, and what stands out among them. */
function stepSummary(g: OpsStepGroup): { text: string; tone: OpsRowTone } {
  const tones = g.rows.map(rowTone)
  const tone = tones.reduce<OpsRowTone>((a, t) => (TONE_RANK[t] > TONE_RANK[a] ? t : a), 'idle')
  const calls = `${g.rows.length} call${g.rows.length === 1 ? '' : 's'}`
  const live = g.rows.some((r) => r.status === 'running' || r.status === 'queued' || r.status === 'asked' || r.status === 'decided')
  if (live) return { text: `${calls} · running`, tone: tone === 'idle' ? 'ok' : tone }
  const bad = tones.filter((t) => t === 'bad').length
  const warn = tones.filter((t) => t === 'warn').length
  const notes = [bad ? `${bad} not allowed` : '', warn ? `${warn} failed` : ''].filter(Boolean)
  return { text: [calls, ...notes].join(' · '), tone: tone === 'idle' ? 'ok' : tone }
}

function StepGroup({
  group,
  open,
  current,
  onToggle,
  children
}: {
  group: OpsStepGroup
  open: boolean
  current: boolean
  onToggle: () => void
  children: ReactElement[]
}) {
  const sum = stepSummary(group)
  return (
    <div className={`ac-step${open ? ' open' : ''}${current ? ' current' : ''}`}>
      <button type="button" className="ac-step-head" aria-expanded={open} onClick={onToggle}>
        <span className="ac-step-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
        {group.n !== undefined && <span className="ac-step-n">{group.n}</span>}
        <span className="ac-step-title" title={group.title}>{group.title}</span>
        <span className={`ac-step-sum ${sum.tone}`}>{sum.text}</span>
      </button>
      {open && children.length > 0 && <div className="ac-step-rows">{children}</div>}
    </div>
  )
}

const SCRIPTS_OPEN_KEY = 'argos.ops.scripts-open'

/** Comment and `== title ==` lines stand out in the script drawer; the rest is plain. */
function ScriptSource({ text }: { text: string }) {
  return (
    <pre className="ac-src">
      {text.split('\n').map((line, i) => {
        const cls = /^\s*#/.test(line) ? 'c' : /==\s*.+?\s*==/.test(line) ? 'm' : ''
        return (
          <span key={i} className={`ac-src-line ${cls}`}>
            <span className="ac-src-n">{i + 1}</span>
            {line}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

/** The script as it is on disk (hash-checked by main), beside the terminal, not over it. */
function ScriptDrawer({
  terminalId,
  script,
  canRun,
  onRun,
  onClose
}: {
  terminalId: string
  script: ScriptInfo
  canRun: boolean
  onRun: () => void
  onClose: () => void
}) {
  const [src, setSrc] = useState<{ text: string; sha256: string } | { error: string } | null>(null)

  useEffect(() => {
    let live = true
    setSrc(null)
    window.electronAPI
      .opsScriptSource(terminalId, script.name)
      .then((r) => {
        if (live) setSrc(r.ok ? { text: r.text, sha256: r.sha256 } : { error: r.error })
      })
      .catch((e) => live && setSrc({ error: String(e) }))
    return () => {
      live = false
    }
  }, [terminalId, script.name])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <>
    <div className="ac-drawer-scrim" {...backdropClose(onClose)} />
    <div className="ac-drawer" role="dialog" aria-label={`Script ${script.name}`}>
      <div className="ac-drawer-head">
        <button type="button" className="ac-icon ac-drawer-back" onClick={onClose} aria-label="Back" title="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="ac-drawer-titles">
          <span className="ac-drawer-title">{script.title}</span>
          <span className="ac-drawer-sub">
            {script.name} · {script.class} · {script.hosts.map((h) => h.name).join(', ') || 'no host'}
          </span>
        </div>
        <button type="button" className="ac-btn" disabled={!canRun} onClick={onRun}>
          Run
        </button>
        <button type="button" className="ac-icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {src && 'sha256' in src && <div className="ac-drawer-hash">sha256 {src.sha256} (matches the policy pin)</div>}
      <div className="ac-drawer-body">
        {!src && <div className="ac-empty">Loading…</div>}
        {src && 'error' in src && <div className="ac-script-err">{src.error}</div>}
        {src && 'text' in src && <ScriptSource text={src.text} />}
      </div>
    </div>
    </>
  )
}

/**
 * The runbook's scripts: folded by default, one line each. A click opens a confirm row
 * (with the arguments or host picker when the script needs them); Run there asks the CLI
 * to run the script through its ops tool, so the model sees the output and can read it
 * back to you. The call goes through the gate and the ledger like any other, and shows up
 * in the list below. The eye shows the script's source in a drawer.
 */
function ScriptsList({ terminalId, runId, disabled }: { terminalId: string; runId?: string; disabled: boolean }) {
  const [scripts, setScripts] = useState<ScriptInfo[]>([])
  const [open, setOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SCRIPTS_OPEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const [argText, setArgText] = useState<Record<string, string>>({})
  const [hostPick, setHostPick] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewing, setViewing] = useState<string | null>(null)

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

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(SCRIPTS_OPEN_KEY, next ? '1' : '0')
    } catch {
      // A remembered fold is a convenience.
    }
  }

  const run = (s: ScriptInfo): void => {
    const host = s.hosts.find((h) => h.id === hostPick[s.name]) ?? s.hosts[0]
    if (!host) return
    const raw = (argText[s.name] ?? '').trim()
    const args = s.maxArgs > 0 && raw ? raw.split(/\s+/) : []
    // One line: a raw newline written into the pty is Enter, not part of the prompt.
    const withArgs = args.length ? ` with the arguments ${JSON.stringify(args)}` : ' with no arguments'
    const prompt =
      `Run the runbook script ${s.name} ("${s.title}") on host ${host.name} (hostId ${host.id})${withArgs}, ` +
      'using the mcp__ops__script tool. Then show me its output and tell me what it means.'
    window.electronAPI.terminalWrite(terminalId, prompt)
    // Enter apart from the text, as ChatTerminal sends a seeded prompt: in the same write
    // the TUI can take the whole chunk as a paste and leave it unsent.
    setTimeout(() => window.electronAPI.terminalWrite(terminalId, '\r'), 200)
    setExpanded(null)
    setViewing(null)
  }

  const needsInput = (s: ScriptInfo): boolean => s.maxArgs > 0 || s.hosts.length > 1
  // A click only opens the confirm row; the run itself is its Run button (or Enter).
  const click = (s: ScriptInfo): void => setExpanded(expanded === s.name ? null : s.name)
  const blocked = (s: ScriptInfo): boolean => disabled || s.hosts.length === 0
  const tip = (s: ScriptInfo): string =>
    s.hosts.length === 0
      ? 'No host of this intervention is in the script’s host groups'
      : `${s.title}\n${s.name} · ${s.class} · ${s.hosts.map((h) => h.name).join(', ')}\nClick to ask the model to run it`
  const viewed = scripts.find((s) => s.name === viewing)

  return (
    <div className="ac-scripts">
      <button type="button" className="ac-scripts-head" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> Scripts <span className="ac-scripts-n">{scripts.length}</span>
      </button>
      {open &&
        scripts.map((s) => (
          <div key={s.name} className="ac-sr-wrap">
            <div className={`ac-sr${blocked(s) ? ' off' : ''}`} title={tip(s)}>
              <button type="button" className="ac-sr-main" disabled={blocked(s)} onClick={() => click(s)}>
                <span className="ac-sr-title">{s.title}</span>
                {s.class === 'mutate' && <span className="ac-sr-tag">changes host</span>}
                <span className="ac-sr-state">{expanded === s.name ? '▾' : ''}</span>
              </button>
              <button type="button" className="ac-icon" aria-label={`View ${s.name}`} title="View the script" onClick={() => setViewing(s.name)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
            {expanded === s.name && (
              <div className="ac-sr-extra">
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
                {s.maxArgs > 0 && (
                  <input
                    className="ac-script-args"
                    placeholder={`arguments (up to ${s.maxArgs})`}
                    value={argText[s.name] ?? ''}
                    onChange={(e) => setArgText({ ...argText, [s.name]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && !blocked(s) && run(s)}
                  />
                )}
                {!needsInput(s) && <span className="ac-sr-ask">Run on {s.hosts[0]?.name}?</span>}
                <button type="button" className="ac-btn" disabled={blocked(s)} onClick={() => run(s)}>
                  Run
                </button>
                <button type="button" className="ac-btn" onClick={() => setExpanded(null)}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        ))}
      {viewed && (
        <ScriptDrawer
          terminalId={terminalId}
          script={viewed}
          canRun={!blocked(viewed)}
          onRun={() => run(viewed)}
          onClose={() => setViewing(null)}
        />
      )}
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
export default function ActivityColumn({ terminalId, runbookPath, current, earlier, loading, waiting, onDecide, onDenyStop, onStop, cliAlive }: Props) {
  const [reportRunId, setReportRunId] = useState<string | null>(null)
  const progress = current ? planProgress(current) : null
  const today = new Date()
  const earlierToday = earlier.filter((r) => sameDay(r.startedAt, today))
  const running = !!current && !current.ended
  const ops = waiting?.ops

  // The calls under the plan steps they carried out; steps that ran nothing are not
  // listed. The step the run is on is open and the rest folded; when the run moves to the next step, that one opens and the last one
  // folds. A click opens or folds any step in between.
  const groups = current ? groupCallsBySteps(current) : []
  const currentKey = current ? currentStepKey(current, groups) : null
  const [openSteps, setOpenSteps] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    if (currentKey) setOpenSteps(new Set([currentKey]))
  }, [currentKey, current?.runId])
  const toggleStep = (key: string): void =>
    setOpenSteps((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  // Host lines sit among the rows at the point the answer came.
  const answers = current ? [...current.hostAnswers] : []
  const rowsOf = (rows: OpsRow[], firstCall: number): ReactElement[] => {
    const out: ReactElement[] = []
    rows.forEach((row, j) => {
      while (answers.length && answers[0].beforeCall <= firstCall + j) {
        const a = answers.shift() as OpsHostAnswer
        out.push(<HostLine key={`h:${a.hostId}:${a.at}`} answer={a} />)
      }
      out.push(<CallRow key={row.callId} row={row} />)
    })
    return out
  }
  const rows: ReactElement[] = []
  // A run with no plan (yet) has nothing to group by: its calls read as a plain list.
  if (groups.length === 1 && groups[0].key === 'pre') rows.push(...rowsOf(groups[0].rows, 0))
  else
    for (const g of groups) {
      const children = rowsOf(g.rows, g.firstCall)
      rows.push(
        <StepGroup key={g.key} group={g} open={openSteps.has(g.key)} current={g.key === currentKey} onToggle={() => toggleStep(g.key)}>
          {children}
        </StepGroup>
      )
    }
  for (const a of answers) rows.push(<HostLine key={`h:${a.hostId}:${a.at}`} answer={a} />)

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
            disabled={onStop ? !running && !cliAlive : !running}
            onClick={() => (onStop ? onStop() : void window.electronAPI.opsStop(terminalId))}
            title={
              onStop
                ? 'End this intervention: pending calls are refused, the CLI is closed and you go back to Ops'
                : "Stop this run: pending calls are refused and the CLI's ops tools stop working"
            }
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
