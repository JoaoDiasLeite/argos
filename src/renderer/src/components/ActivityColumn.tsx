import { Fragment, useEffect, useState, type ReactElement, type ReactNode } from 'react'
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
import { plural, type TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
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

const clock = (iso: string | undefined, locale: string | undefined): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
}

/** A translated sentence with markup inside it: the `{name}` placeholders the template
 *  still holds (it was fetched without those params) are swapped for the given nodes. */
function withNodes(template: string, nodes: Record<string, ReactNode>): ReactNode[] {
  return template.split(/\{(\w+)\}/).map((part, i) => (i % 2 === 1 ? <Fragment key={i}>{nodes[part]}</Fragment> : part))
}

const sameDay = (iso: string, now: Date): boolean => {
  const d = new Date(iso)
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
}

/** The command, or `read <path>` for a file tool. */
const rowText = (r: OpsRow): string =>
  r.argv && r.argv.length ? displayArgv(r.argv) : r.path ? `${r.tool || 'read'} ${r.path}` : r.tool || r.callId

function runState(run: OpsRun, t: TFunction, locale: string | undefined): string {
  if (!run.ended) return t('sessions.activity.run.runningSince', { time: clock(run.startedAt, locale) })
  if (run.ended.aborted) return t('sessions.activity.run.stopped')
  return t('sessions.activity.run.finished', { time: clock(run.endedAt, locale) })
}

function earlierState(run: OpsRun, t: TFunction): string {
  if (!run.ended) return t('sessions.activity.earlier.notClosed')
  return run.ended.aborted
    ? t('sessions.activity.earlier.stopped')
    : run.ended.ok
      ? t('sessions.activity.earlier.finished')
      : t('sessions.activity.earlier.failed')
}

/** One `== title ==` section of a script's output, folded until clicked. */
function SectionItem({ section, forceOpen }: { section: OpsOutputSection; forceOpen: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const shown = open || forceOpen
  return (
    <div className={`ac-sec${shown ? ' open' : ''}`}>
      <button type="button" className="ac-sec-head" aria-expanded={shown} onClick={() => setOpen(!shown)}>
        <span className="ac-sec-caret" aria-hidden="true">{shown ? '▾' : '▸'}</span>
        <span className="ac-sec-title">{section.title || t('sessions.activity.section.output')}</span>
        {!shown && section.body && <span className="ac-sec-peek">{section.body.split('\n')[0]}</span>}
      </button>
      {shown && <pre className="ac-sec-body">{section.body || t('sessions.activity.section.noOutput')}</pre>}
    </div>
  )
}

/** A script's output as one folded line per section, with an expand-all toggle. */
function SectionedOutput({ sections, stderr }: { sections: OpsOutputSection[]; stderr: string }) {
  const t = useT()
  const [all, setAll] = useState(false)
  return (
    <div className="ac-secs">
      <button type="button" className="ac-link ac-secs-all" onClick={() => setAll((v) => !v)}>
        {all ? t('sessions.activity.section.collapseAll') : t('sessions.activity.section.expandAll')}
      </button>
      {sections.map((s, i) => (
        <SectionItem key={`${i}:${s.title}`} section={s} forceOpen={all} />
      ))}
      {stderr && <pre className="ac-sec-body ac-sec-err">{stderr}</pre>}
    </div>
  )
}

function CallRow({ row }: { row: OpsRow }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const tone = rowTone(row)
  const output = [row.stdoutHead, row.stderrHead].filter(Boolean).join('\n')
  const sections = row.tool === 'script' && row.stdoutHead ? splitSections(row.stdoutHead) : null
  const refused = row.status === 'denied' || row.status === 'stopped'
  const text = rowText(row)
  const label = rowLabel(row, t)
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
function stepSummary(g: OpsStepGroup, t: TFunction): { text: string; tone: OpsRowTone } {
  const tones = g.rows.map(rowTone)
  const tone = tones.reduce<OpsRowTone>((a, x) => (TONE_RANK[x] > TONE_RANK[a] ? x : a), 'idle')
  const calls = plural(t, 'sessions.activity.calls', g.rows.length)
  const live = g.rows.some((r) => r.status === 'running' || r.status === 'queued' || r.status === 'asked' || r.status === 'decided')
  if (live) return { text: t('sessions.activity.step.running', { calls }), tone: tone === 'idle' ? 'ok' : tone }
  const bad = tones.filter((x) => x === 'bad').length
  const warn = tones.filter((x) => x === 'warn').length
  const notes = [
    bad ? t('sessions.activity.step.notAllowed', { n: bad }) : '',
    warn ? t('sessions.activity.step.failed', { n: warn }) : ''
  ].filter(Boolean)
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
  const t = useT()
  const sum = stepSummary(group, t)
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
  const t = useT()
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
    <div className="ac-drawer" role="dialog" aria-label={t('sessions.activity.drawer.label', { name: script.name })}>
      <div className="ac-drawer-head">
        <button type="button" className="ac-icon ac-drawer-back" onClick={onClose} aria-label={t('sessions.activity.drawer.back')} title={t('sessions.activity.drawer.back')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="ac-drawer-titles">
          <span className="ac-drawer-title">{script.title}</span>
          <span className="ac-drawer-sub">
            {script.name} · {script.class} · {script.hosts.map((h) => h.name).join(', ') || t('sessions.activity.drawer.noHost')}
          </span>
        </div>
        <button type="button" className="ac-btn" disabled={!canRun} onClick={onRun}>
          {t('sessions.activity.run')}
        </button>
        <button type="button" className="ac-icon" onClick={onClose} aria-label={t('common.close')}>
          ✕
        </button>
      </div>
      {src && 'sha256' in src && <div className="ac-drawer-hash">{t('sessions.activity.drawer.hash', { hash: src.sha256 })}</div>}
      <div className="ac-drawer-body">
        {!src && <div className="ac-empty">{t('sessions.activity.loading')}</div>}
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
  const t = useT()
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
      ? t('sessions.activity.scripts.noHostTip')
      : t('sessions.activity.scripts.tip', {
          title: s.title,
          name: s.name,
          class: s.class,
          hosts: s.hosts.map((h) => h.name).join(', ')
        })
  const viewed = scripts.find((s) => s.name === viewing)

  return (
    <div className="ac-scripts">
      <button type="button" className="ac-scripts-head" aria-expanded={open} onClick={toggle}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span> {t('sessions.activity.scripts.title')} <span className="ac-scripts-n">{scripts.length}</span>
      </button>
      {open &&
        scripts.map((s) => (
          <div key={s.name} className="ac-sr-wrap">
            <div className={`ac-sr${blocked(s) ? ' off' : ''}`} title={tip(s)}>
              <button type="button" className="ac-sr-main" disabled={blocked(s)} onClick={() => click(s)}>
                <span className="ac-sr-title">{s.title}</span>
                {s.class === 'mutate' && <span className="ac-sr-tag">{t('sessions.activity.scripts.changesHost')}</span>}
                <span className="ac-sr-state">{expanded === s.name ? '▾' : ''}</span>
              </button>
              <button type="button" className="ac-icon" aria-label={t('sessions.activity.scripts.view', { name: s.name })} title={t('sessions.activity.scripts.viewTitle')} onClick={() => setViewing(s.name)}>
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
                    aria-label={t('sessions.activity.scripts.hostFor', { name: s.name })}
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
                    placeholder={t('sessions.activity.scripts.args', { n: s.maxArgs })}
                    value={argText[s.name] ?? ''}
                    onChange={(e) => setArgText({ ...argText, [s.name]: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && !blocked(s) && run(s)}
                  />
                )}
                {!needsInput(s) && <span className="ac-sr-ask">{t('sessions.activity.scripts.runOn', { host: s.hosts[0]?.name ?? '' })}</span>}
                <button type="button" className="ac-btn" disabled={blocked(s)} onClick={() => run(s)}>
                  {t('sessions.activity.run')}
                </button>
                <button type="button" className="ac-btn" onClick={() => setExpanded(null)}>
                  {t('common.cancel')}
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
  const t = useT()
  const { locale } = useLanguage()
  return (
    <div className={`ac-hostline ${answer.answer}`}>
      {t(answer.answer === 'approved' ? 'sessions.activity.host.allowed' : 'sessions.activity.host.refused', {
        host: answer.host,
        time: clock(answer.at, locale)
      })}
    </div>
  )
}

/** The call or host variant of the waiting block. */
function WaitingCall({ ops, onDecide }: { ops: ApprovalOpsContext; onDecide: (allow: boolean) => void }) {
  const t = useT()
  if (ops.tool === 'host') {
    return (
      <>
        <div className="ac-wait-head">
          <span className="ac-wait-eyebrow">{t('sessions.activity.wait.eyebrow')}</span>
          <span className="ac-wait-tag">{t('sessions.activity.wait.newHost')}</span>
        </div>
        <div className="ac-wait-title">
          {withNodes(t('sessions.activity.wait.reach'), { host: <strong>{ops.hostName}</strong> })}
        </div>
        <div className="ac-wait-cmd">{ops.hostAddress}</div>
        <div className="ac-wait-actions">
          <button type="button" className="ac-allow" onClick={() => onDecide(true)}>
            {t('sessions.activity.wait.allow')}
          </button>
          <button type="button" className="ac-deny" onClick={() => onDecide(false)}>
            {t('sessions.activity.wait.deny')}
          </button>
        </div>
      </>
    )
  }
  const { verb, lines } = describeOpsRequest(ops, t)
  const sudo = ops.argv?.[0] === 'sudo'
  const title = ops.title || verb.charAt(0).toUpperCase() + verb.slice(1)
  return (
    <>
      <div className="ac-wait-head">
        <span className="ac-wait-eyebrow">{t('sessions.activity.wait.eyebrow')}</span>
        <span className="ac-wait-tag">
          {sudo
            ? 'sudo'
            : ops.class === 'mutate'
              ? t('sessions.activity.wait.changesHost')
              : t('sessions.activity.wait.read')}
        </span>
      </div>
      <div className="ac-wait-title">{title}</div>
      {lines.length > 0 && <div className="ac-wait-cmd">{lines.join('\n')}</div>}
      {sudo && ops.reason && <div className="ac-wait-reason">{ops.reason}</div>}
      {ops.queuedBehind > 0 && (
        <div className="ac-wait-reason">
          {plural(t, 'sessions.activity.wait.queued', ops.queuedBehind, { host: ops.hostName })}
        </div>
      )}
      <div className="ac-wait-actions">
        <button type="button" className="ac-allow" onClick={() => onDecide(true)}>
          {t('sessions.activity.wait.allow')}
        </button>
        <button type="button" className="ac-deny" onClick={() => onDecide(false)}>
          {t('sessions.activity.wait.deny')}
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
  const t = useT()
  const { locale } = useLanguage()
  const [reportRunId, setReportRunId] = useState<string | null>(null)
  const progress = current ? planProgress(current) : null
  const today = new Date()
  const earlierToday = earlier.filter((r) => sameDay(r.startedAt, today))
  const running = !!current && !current.ended
  const ops = waiting?.ops

  // The calls under the plan steps they carried out; steps that ran nothing are not
  // listed. The step the run is on is open and the rest folded; when the run moves to the next step, that one opens and the last one
  // folds. A click opens or folds any step in between.
  const groups = current ? groupCallsBySteps(current, t) : []
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
    <aside className="ac" aria-label={t('sessions.activity.label')}>
      <div className="ac-run">
        <div className="ac-run-line">
          <span className="ac-run-state">{current ? runState(current, t, locale) : loading ? t('sessions.activity.loading') : t('sessions.activity.run.starting')}</span>
          {progress && (
            <span className="ac-run-steps">
              {plural(t, 'sessions.activity.run.steps', progress.total, { done: progress.done })}
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
            {t('sessions.activity.report')}
          </button>
          <button
            type="button"
            className="ac-btn stop"
            disabled={onStop ? !running && !cliAlive : !running}
            onClick={() => (onStop ? onStop() : void window.electronAPI.opsStop(terminalId))}
            title={
              onStop
                ? t('sessions.activity.run.endTitle')
                : t('sessions.activity.run.stopTitle')
            }
          >
            {t('sessions.activity.run.stop')}
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
              {t('sessions.activity.wait.denyStop')}
            </button>
          )}
        </div>
      )}

      <ScriptsList terminalId={terminalId} runId={current?.runId} disabled={!!current?.ended || !!waiting} />

      <div className="ac-list">
        {current && rows.length === 0 && <p className="ac-empty">{t('sessions.activity.noCalls')}</p>}
        {rows}

        {earlierToday.length > 0 && (
          <>
            <div className="ac-divider">
              <span>
                {plural(t, 'sessions.activity.earlier.title', earlierToday.length)}
              </span>
            </div>
            {earlierToday.map((r) => (
              <div key={r.runId} className="ac-earlier">
                <span>
                  {t('sessions.activity.earlier.line', {
                    time: clock(r.startedAt, locale),
                    state: earlierState(r, t),
                    calls: plural(t, 'sessions.activity.calls', r.calls.length)
                  })}
                </span>
                <span className="ac-muted">${(r.ended?.costUsd ?? 0).toFixed(2)}</span>
                <button type="button" className="ac-link" onClick={() => setReportRunId(r.runId)}>
                  {t('sessions.activity.report')}
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
