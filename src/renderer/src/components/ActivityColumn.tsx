import { useEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react'
import { rich } from '../lib/t-rich'
import type { ApprovalOpsContext, ApprovalRequest, OpsOperatorRequest } from '../types'
import { describeOpsRequest, displayArgv } from '../lib/ops-approval'
import { splitSections, type OpsOutputSection } from '../lib/ops-sections'
import {
  currentStepKey,
  groupCallsBySteps,
  planProgress,
  rowLabel,
  rowTone,
  type OpsHostAnswer,
  type OpsHypothesis,
  type OpsOperatorAsk,
  type OpsRow,
  type OpsRowTone,
  type OpsRunLink,
  type OpsRun,
  type OpsStepGroup
} from '../lib/ops-timeline'
import OpsReferPicker from './OpsReferPicker'
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
  /** The model's ask_operator requests still open on this terminal (App owns them). */
  operatorRequests?: OpsOperatorRequest[]
  /** Answer one with the pasted output; null declines. */
  onOperatorAnswer?: (requestId: string, output: string | null) => void
  /** The header's panel toggle hid the panel (an approval or a card still shows it). */
  collapsed?: boolean
  /** The Context section's chips: the server and the mode the intervention runs in. */
  serverLabel?: string
  modeLabel?: string
  /** "Hand over to a runbook…" in the footer: given only for a diagnosis that can. */
  onHandover?: () => void
  handoverDisabled?: boolean
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

/** The command, or `read <path>` for a file tool. */
const rowText = (r: OpsRow): string =>
  r.argv && r.argv.length ? displayArgv(r.argv) : r.path ? `${r.tool || 'read'} ${r.path}` : r.tool || r.callId

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
  const cls = `ac-row${open ? ' open' : ''}${refused ? ' refused' : ''}${output ? ' has-output' : ''}${row.status === 'running' ? ' running' : ''}`
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
        {t('sessions.activity.scripts.title')} <span className="ac-scripts-n">{scripts.length}</span>
        <svg className={`ac-chev right${open ? ' open' : ''}`} width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 18 6-6-6-6" />
        </svg>
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

const shortDate = (iso: string, locale: string | undefined): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' })
}

/** "The model looked up the intervention of 03/11" / "You referred to …". The date is known
 *  when the referred run is among the ones this column has seen;
 *  otherwise the short run id stands in. */
function LinkLine({ link, startedAt }: { link: OpsRunLink; startedAt?: string }) {
  const t = useT()
  const { locale } = useLanguage()
  const when = startedAt ? shortDate(startedAt, locale) : ''
  const id = link.refRunId ? link.refRunId.slice(0, 8) : ''
  const text =
    link.kind === 'referenced'
      ? when
        ? t('ops.activity.referred', { when })
        : t('ops.activity.referredId', { id })
      : !link.refRunId
        ? t('ops.activity.modelReadList')
        : when
          ? t('ops.activity.modelRead', { when })
          : t('ops.activity.modelReadId', { id })
  return <div className="ac-hostline approved">{text}</div>
}

const FOLD_PREFIX = 'argos.ops.panel.'

/** A section's folded state, remembered per section across tabs and restarts. */
function useFold(id: string): [boolean, () => void] {
  const [closed, setClosed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(FOLD_PREFIX + id) === '1'
    } catch {
      return false
    }
  })
  const toggle = (): void =>
    setClosed((c) => {
      try {
        localStorage.setItem(FOLD_PREFIX + id, c ? '0' : '1')
      } catch {
        // A remembered fold is a convenience.
      }
      return !c
    })
  return [closed, toggle]
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg className={`ac-chev${open ? ' open' : ''}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  )
}

/** One collapsible section of the side panel: a header row (title, muted count, chevron). */
function PanelSection({
  id,
  title,
  count,
  sectionRef,
  children
}: {
  id: string
  title: string
  count?: string
  sectionRef?: Ref<HTMLElement>
  children: ReactNode
}) {
  const t = useT()
  const [closed, toggle] = useFold(id)
  return (
    <section className="ac-ps" ref={sectionRef}>
      <button type="button" className="ac-ps-head" aria-expanded={!closed} title={t('sessions.activity.panel.toggle', { name: title })} onClick={toggle}>
        <span className="ac-ps-title">{title}</span>
        {count && <span className="ac-ps-count">{count}</span>}
        <span className="ac-ps-spacer" />
        <Chevron open={!closed} />
      </button>
      {!closed && <div className="ac-ps-body">{children}</div>}
    </section>
  )
}

/** A row's slot. Opens its height and slides in from the right when `entering` was true at
 *  the moment it mounted (a row that arrived after the list was on screen); otherwise it
 *  is a plain wrapper. The choice is taken once, so a later render cannot cut the motion. */
function Slot({ entering, children }: { entering: boolean; children: ReactNode }) {
  const [enter] = useState(entering)
  return (
    <div className={`ac-slot${enter ? ' enter' : ''}`}>
      <div className="ac-slot-in">{children}</div>
    </div>
  )
}

/** The model's hypotheses as a checklist, then its findings; the plan's progress on top. */
function ProgressBody({ run, progress }: { run: OpsRun; progress: { done: number; total: number } | null }) {
  const t = useT()
  const statusText = (s: OpsHypothesis['status']): string =>
    s === 'confirmed' ? t('sessions.activity.notes.confirmed') : s === 'ruled_out' ? t('sessions.activity.notes.ruledOut') : t('sessions.activity.notes.open')
  return (
    <div className="ac-notes">
      {progress && (
        <div className="ac-plan">
          <span className="ac-plan-steps">{plural(t, 'sessions.activity.run.steps', progress.total, { done: progress.done })}</span>
          <div className="ac-progress" aria-hidden="true">
            <span style={{ width: `${(progress.done / progress.total) * 100}%` }} />
          </div>
        </div>
      )}
      {run.hypotheses.map((h) => (
        <div key={h.id} className={`ac-hyp ${h.status}`}>
          <span className="ac-hyp-mark" role="img" aria-label={statusText(h.status)} title={statusText(h.status)}>
            {h.status === 'confirmed' && (
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            )}
          </span>
          <span className="ac-hyp-text">
            {h.text}
            {h.evidence && <small>{h.evidence}</small>}
          </span>
        </div>
      ))}
      {run.findings.map((f, i) => (
        <div key={`f${i}`} className="ac-find">
          <span className="ac-find-dot" aria-hidden="true" />
          <span className="ac-hyp-text">
            {f.text}
            {f.evidence && <small>{f.evidence}</small>}
          </span>
        </div>
      ))}
    </div>
  )
}

/** A command the model handed the operator, as a line among the calls: run (with the
 *  pasted output behind a click), declined, or still waiting. */
function AskRow({ ask }: { ask: OpsOperatorAsk }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const tone: OpsRowTone = ask.state === 'answered' ? 'ok' : ask.state === 'declined' ? 'bad' : 'warn'
  const label =
    ask.state === 'answered'
      ? `✓ ${t('sessions.activity.ask.ran')}`
      : ask.state === 'declined'
        ? t('sessions.activity.ask.declined')
        : t('sessions.activity.ask.waiting')
  const output = ask.state === 'answered' && ask.output ? ask.output + (ask.truncated ? `\n${t('sessions.activity.ask.truncated')}` : '') : ''
  const cls = `ac-row ac-askrow${open ? ' open' : ''}${output ? ' has-output' : ''}`
  const inner = (
    <>
      <span className={`ac-dot ${tone}`} aria-hidden="true" />
      <span className="ac-cmd" title={[ask.cmd, ask.why, ask.host].filter(Boolean).join('\n')}>
        {ask.cmd}
      </span>
      <span className={`ac-label ${tone === 'ok' ? 'ran' : tone}`}>{label}</span>
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

// What the operator has typed into a card, kept across a tab switch until it is sent.
const askDrafts = new Map<string, string>()

/**
 * "For you to run": a command the model may not run itself, waiting for the operator to run
 * it in their own SSH session and paste the output back, or to decline. The model's tool
 * call is blocked until then.
 */
function OperatorCard({ req, onAnswer }: { req: OpsOperatorRequest; onAnswer: (requestId: string, output: string | null) => void }) {
  const t = useT()
  const [text, setText] = useState(() => askDrafts.get(req.requestId) ?? '')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(id)
  }, [copied])
  const copy = (): void => {
    // The main process's clipboard when the renderer's is refused (no focus, no permission).
    navigator.clipboard
      .writeText(req.cmd)
      .catch(() => window.electronAPI.clipboardWrite(req.cmd))
      .then(
        () => setCopied(true),
        () => {}
      )
  }
  const edit = (v: string): void => {
    setText(v)
    askDrafts.set(req.requestId, v)
  }
  const answer = (output: string | null): void => {
    askDrafts.delete(req.requestId)
    onAnswer(req.requestId, output)
  }
  return (
    <div className="ac-op" role="group" aria-label={t('sessions.activity.ask.eyebrow')}>
      <div className="ac-wait-head">
        <span className="ac-wait-eyebrow">{t('sessions.activity.ask.eyebrow')}</span>
        {req.hostName && <span className="ac-wait-tag">{t('sessions.activity.ask.on', { host: req.hostName })}</span>}
      </div>
      <div className="ac-wait-title">{req.why}</div>
      <div className="ac-op-cmd">
        <code>{req.cmd}</code>
        <button type="button" className="ac-btn" onClick={copy}>
          {copied ? t('sessions.activity.ask.copied') : t('sessions.activity.ask.copy')}
        </button>
      </div>
      {req.expect && <div className="ac-wait-reason">{t('sessions.activity.ask.expect', { expect: req.expect })}</div>}
      <textarea
        className="ac-op-paste"
        placeholder={t('sessions.activity.ask.paste')}
        aria-label={t('sessions.activity.ask.paste')}
        spellCheck={false}
        value={text}
        onChange={(e) => edit(e.target.value)}
      />
      <div className="ac-wait-actions">
        <button type="button" className="ac-allow" disabled={!text.trim()} onClick={() => answer(text)}>
          {t('sessions.activity.ask.send')}
        </button>
        <button type="button" className="ac-deny" onClick={() => answer(null)}>
          {t('sessions.activity.ask.decline')}
        </button>
      </div>
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
          {rich(t('sessions.activity.wait.reach'), { host: <strong>{ops.hostName}</strong> })}
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

const whenOf = (id: string, known: Map<string, string>, locale: string | undefined): string => {
  const at = known.get(id)
  if (!at) return id.slice(0, 8)
  return [shortDate(at, locale), clock(at, locale)].filter(Boolean).join(' ')
}

/**
 * The Ops workspace's side panel (docs/INTERVENTIONS_PLAN.md §4, board D2): whatever waits
 * for the operator pinned at the top as the only highlighted block, then three collapsible
 * sections: Progress (plan, hypotheses, findings), Context (server, runbook, linked runs,
 * scripts) and Activity (one line per call, newest first, earlier runs folded at the end).
 * The run's state and Stop live in the workspace's own header; Refer is a chip in Context
 * and Handover sits in the footer.
 */
export default function ActivityColumn({
  terminalId,
  runbookPath,
  current,
  earlier,
  loading,
  waiting,
  onDecide,
  onDenyStop,
  operatorRequests,
  onOperatorAnswer,
  collapsed,
  serverLabel,
  modeLabel,
  onHandover,
  handoverDisabled
}: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [reportRunId, setReportRunId] = useState<string | null>(null)
  const [referOpen, setReferOpen] = useState(false)
  const contextRef = useRef<HTMLElement>(null)
  const referChipRef = useRef<HTMLButtonElement>(null)
  const live = !!current && !current.ended
  const progress = current ? planProgress(current) : null
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

  // The operator's open requests, until the ledger shows their answer (App drops them then
  // too; this covers the moment between).
  const settledAsks = new Set(
    [current, ...earlier].flatMap((r) => (r ? r.asks.filter((a) => a.state !== 'pending').map((a) => `${r.runId}:${a.askId}`) : []))
  )
  const cards = onOperatorAnswer
    ? (operatorRequests ?? []).filter((r) => r.appSessionId === terminalId && !settledAsks.has(`${r.runId}:${r.askId}`))
    : []
  const carded = new Set(cards.filter((r) => r.runId === current?.runId).map((r) => r.askId))
  const pending = !!(waiting && ops && onDecide) || cards.length > 0
  // A run the operator stopped ended as asked: its reason is not an error to show in red.
  const endError = current?.ended && !current.ended.aborted ? current.ended.error : undefined

  // ── New rows: which ones arrive after the list is on screen ──
  // `seen` holds every row key shown so far (updated after each commit); `ready` turns on
  // once the history has loaded, so what is there on first render or after a tab switch
  // never animates. A list scrolled away from its top is left alone: new rows are counted
  // into a pill instead of moving what the operator is reading.
  const bodyRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const seenRef = useRef<Set<string>>(new Set())
  const readyRef = useRef(false)
  const scrolledRef = useRef(false)
  const [newCount, setNewCount] = useState(0)
  const keys: string[] = []
  const canAnimate = readyRef.current && !scrolledRef.current
  const isNew = (key: string): boolean => canAnimate && !seenRef.current.has(key)
  const slot = (key: string, el: ReactElement, suppress = false): ReactElement => {
    keys.push(key)
    return (
      <Slot key={key} entering={!suppress && isNew(key)}>
        {el}
      </Slot>
    )
  }

  // Host lines and the operator's commands sit among the rows at the point they came; a
  // command still on its card is not listed twice.
  const knownStart = new Map([current, ...earlier].flatMap((r) => (r ? [[r.runId, r.startedAt] as const] : [])))
  const lines: { beforeCall: number; at: string; key: string; el: ReactElement }[] = current
    ? [
        ...(current.links ?? []).map((l, i) => ({
          beforeCall: l.beforeCall,
          at: l.at,
          key: `${current.runId}:l:${i}`,
          el: <LinkLine link={l} startedAt={l.refRunId ? knownStart.get(l.refRunId) : undefined} />
        })),
        ...current.hostAnswers.map((a: OpsHostAnswer) => ({
          beforeCall: a.beforeCall,
          at: a.at,
          key: `${current.runId}:h:${a.hostId}:${a.at}`,
          el: <HostLine answer={a} />
        })),
        ...current.asks
          .filter((a) => !carded.has(a.askId))
          .map((a) => ({ beforeCall: a.beforeCall, at: a.at, key: `${current.runId}:a:${a.askId}`, el: <AskRow ask={a} /> }))
      ].sort((a, b) => a.beforeCall - b.beforeCall || (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    : []
  // Built oldest first (a line sits before the call it preceded), then flipped: newest on top.
  const rowsOf = (rows: OpsRow[], firstCall: number, suppress: boolean): ReactElement[] => {
    const out: ReactElement[] = []
    rows.forEach((row, j) => {
      while (lines.length && lines[0].beforeCall <= firstCall + j) {
        const l = lines.shift()!
        out.push(slot(l.key, l.el, suppress))
      }
      out.push(slot(`${current?.runId}:c:${row.callId}`, <CallRow row={row} />, suppress))
    })
    return out
  }
  const items: ReactElement[] = []
  // A run with no plan (yet) has nothing to group by: its calls read as a plain list.
  if (groups.length === 1 && groups[0].key === 'pre') items.push(...rowsOf(groups[0].rows, 0, false))
  else
    for (const g of groups) {
      const gk = `${current?.runId}:g:${g.key}`
      // A step that opens now carries its rows in with it.
      const children = rowsOf(g.rows, g.firstCall, isNew(gk)).reverse()
      items.push(
        slot(
          gk,
          <StepGroup group={g} open={openSteps.has(g.key)} current={g.key === currentKey} onToggle={() => toggleStep(g.key)}>
            {children}
          </StepGroup>
        )
      )
    }
  for (const l of lines) items.push(slot(l.key, l.el))
  items.reverse()

  const keySig = keys.join('\n')
  useEffect(() => {
    const seen = seenRef.current
    let added = 0
    for (const k of keys) {
      if (seen.has(k)) continue
      seen.add(k)
      if (!k.includes(':g:')) added++
    }
    if (readyRef.current && scrolledRef.current && added > 0) setNewCount((c) => c + added)
    if (!loading) readyRef.current = true
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySig, loading])

  /** How far the list's first row is above the panel's visible top. */
  const awayFromTop = (): number => {
    const body = bodyRef.current
    const list = listRef.current
    return body && list ? body.getBoundingClientRect().top - list.getBoundingClientRect().top : 0
  }
  const onBodyScroll = (): void => {
    const away = awayFromTop() > 8
    scrolledRef.current = away
    if (!away) setNewCount(0)
  }
  const showNew = (): void => {
    const body = bodyRef.current
    const sec = sectionRef.current
    if (!body || !sec) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    body.scrollBy({ top: sec.getBoundingClientRect().top - body.getBoundingClientRect().top - 10, behavior: reduce ? 'auto' : 'smooth' })
    setNewCount(0)
  }

  const runLinks: { key: string; text: string }[] = []
  if (current?.resumesRunId) runLinks.push({ key: 'resumes', text: t('sessions.activity.panel.resumes', { when: whenOf(current.resumesRunId, knownStart, locale) }) })
  for (const id of current?.relatedRunIds ?? []) runLinks.push({ key: `rel:${id}`, text: t('sessions.activity.panel.related', { when: whenOf(id, knownStart, locale) }) })
  const referred = new Set((current?.links ?? []).filter((l) => l.kind === 'referenced' && l.refRunId).map((l) => l.refRunId as string))
  for (const id of referred) runLinks.push({ key: `ref:${id}`, text: t('sessions.activity.panel.refers', { when: whenOf(id, knownStart, locale) }) })

  const hasProgress = !!progress || (current ? current.hypotheses.length > 0 || current.findings.length > 0 : false)
  // Folded away by the header's panel toggle; an approval or a card still shows it, since the
  // run is blocked until the operator answers.
  const hide = !!collapsed && !pending

  return (
    <aside className={`ac${hide ? ' hidden' : ''}`} aria-label={t('sessions.activity.label')} aria-hidden={hide || undefined}>
      {(pending || endError) && (
        <div className="ac-pinned">
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

          {cards.length > 0 && onOperatorAnswer && (
            <div className="ac-op-wrap">
              {cards.map((r) => (
                <OperatorCard key={r.requestId} req={r} onAnswer={onOperatorAnswer} />
              ))}
            </div>
          )}

          {endError && <div className="ac-run-error">{endError}</div>}
        </div>
      )}

      <div className="ac-body" ref={bodyRef} onScroll={onBodyScroll}>
        {newCount > 0 && (
          <div className="ac-newpill-wrap">
            <button type="button" className="ac-newpill" onClick={showNew}>
              {t('sessions.activity.panel.newRows', { n: newCount })}
            </button>
          </div>
        )}

        {hasProgress && current && (
          <PanelSection id="progress" title={t('sessions.activity.panel.progress')}>
            <ProgressBody run={current} progress={progress} />
          </PanelSection>
        )}

        <PanelSection id="context" title={t('sessions.activity.panel.context')} sectionRef={contextRef}>
          <div className="ac-chips">
            {serverLabel && <span className="ac-chip">{serverLabel}</span>}
            {modeLabel && <span className="ac-chip">{modeLabel}</span>}
            {runLinks.map((l) => (
              <span key={l.key} className="ac-chip link">
                {l.text}
              </span>
            ))}
            {live && (
              <button
                type="button"
                ref={referChipRef}
                className="ac-chip refer"
                aria-haspopup="listbox"
                aria-expanded={referOpen}
                title={t('ops.activity.referTitle')}
                onClick={() => setReferOpen((o) => !o)}
              >
                {t('ops.activity.referChip')}
              </button>
            )}
          </div>
          {/* The model's tool call is blocked on a card: a script prompt would only queue behind it. */}
          <ScriptsList terminalId={terminalId} runId={current?.runId} disabled={!!current?.ended || !!waiting || cards.length > 0} />
        </PanelSection>

        <PanelSection
          id="activity"
          title={t('sessions.activity.panel.activity')}
          count={current ? plural(t, 'sessions.activity.calls', current.calls.length) : undefined}
          sectionRef={sectionRef}
        >
          <div className="ac-list" ref={listRef}>
            {!current && loading && <p className="ac-empty">{t('sessions.activity.loading')}</p>}
            {current && items.length === 0 && <p className="ac-empty">{t('sessions.activity.noCalls')}</p>}
            {items}

          </div>
        </PanelSection>
      </div>

      {live && referOpen && current && (
        <OpsReferPicker
          terminalId={terminalId}
          run={current}
          serverLabel={serverLabel}
          anchorRef={contextRef}
          chipRef={referChipRef}
          onClose={() => setReferOpen(false)}
        />
      )}

      {current && (
        <div className="ac-foot">
          <button type="button" className="ac-foot-btn" onClick={() => setReportRunId(current.runId)} title={t('ops.workspace.handoverReportTitle')}>
            {t('ops.workspace.handoverReport')}
          </button>
          {onHandover && (
            <button type="button" className="ac-foot-btn wide" disabled={handoverDisabled} onClick={onHandover} title={t('ops.workspace.handoverTitle')}>
              {t('ops.workspace.handover')}
            </button>
          )}
        </div>
      )}

      {reportRunId && (
        <OpsReportSheet runId={reportRunId} appSessionId={terminalId} runbookPath={runbookPath} onClose={() => setReportRunId(null)} />
      )}
    </aside>
  )
}
