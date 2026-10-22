import { useEffect, useId, useRef, useState } from 'react'
import { rich } from '../lib/t-rich'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import type { OpsIntervention, OpsRunListItem, OpsScope, SshHostPublic } from '../types'
import { writeLastRunbook } from '../lib/runbook-library'
import { samePath, useBuiltinRunbook } from '../lib/builtin-runbook'
import OpsReportSheet from '../components/OpsReportSheet'
import InterventionTag from '../components/InterventionTag'
import { interventionLabel } from '../lib/intervention-label'
import { IvsDropdown, RunbookField, runbookHostProblem, useRunbookPicker, type DropItem, type InfoState } from '../components/RunbookPicker'
import { plural, type TFunction } from '../../../shared/i18n'
import { useLanguage, useT } from '../i18n'
import './InterventionStart.css'

/**
 * Servers → Ops: the start of an intervention (docs/INTERVENTIONS_PLAN.md §4, board C2).
 * One server (or, deliberately, any server the runbook allows), one runbook, one task.
 * The right column says in plain words what the runbook allows before anything runs, and
 * lists the earlier runs on the chosen server.
 *
 * Runbooks are the runbooks folder of Settings (every subfolder that looks like one) and the
 * loose runbooks picked one by one, rescanned and re-read on mount: a runbook is a folder
 * someone edits, and a policy that stopped validating is exactly what must show here.
 *
 * The mode comes first: despiste (the read-only runbook shipped with Argos) is always the
 * default and is not remembered; an intervention with a runbook is chosen on purpose.
 */

const LAST_CLIENT_KEY = 'ops.lastClient'
const HISTORY_LIMIT = 8

type DotState = 'checking' | 'ok' | 'error'
/** `null` until chosen; `'open'` is "Any server this runbook allows". */
type ServerChoice = string | 'open' | null
type Mode = 'despiste' | 'runbook'

const OPEN = 'open' as const
const MODES: Mode[] = ['despiste', 'runbook']
/**
 * The names the built-in runbook's runs carry in the ledger: its folder name, and the one
 * it had before 2.9.0 shipped (`despiste`), so runs from then still map to it.
 */
const BUILTIN_NAMES = ['diagnosis', 'despiste']
/** A pre-rename path of the built-in runbook, as an older run recorded it. */
const OLD_BUILTIN_PATH_RE = /[\\/]resources[\\/]runbooks[\\/]despiste[\\/]?$/i

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const hostAddress = (h: SshHostPublic) => `${h.username}@${h.host}${h.port === 22 ? '' : `:${h.port}`}`

function readLastClient(): string {
  try {
    return localStorage.getItem(LAST_CLIENT_KEY) ?? ''
  } catch {
    return ''
  }
}
function writeLastClient(client: string) {
  try {
    if (client) localStorage.setItem(LAST_CLIENT_KEY, client)
  } catch {
    /* storage unavailable: the client just isn't remembered */
  }
}

/** "a", "a and b", "a, b and c". */
function joinAnd(items: ReactNode[], t: TFunction): ReactNode[] {
  const out: ReactNode[] = []
  items.forEach((item, i) => {
    if (i > 0) out.push(i === items.length - 1 ? t('ops.start.and') : ', ')
    out.push(item)
  })
  return out
}

function withStop(s: string): string {
  const t = s.trim()
  return /[.!?…:]$/.test(t) ? t : `${t}.`
}

function runWhen(iso: string, t: TFunction, locale?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 86_400_000)
  if (diff === 0) return t('ops.start.today', { time })
  if (diff === 1) return t('ops.start.yesterday')
  return d.toLocaleDateString(locale, { day: 'numeric', month: 'short' })
}

function runStatus(r: OpsRunListItem, t: TFunction): { label: string; tone: 'ok' | 'bad' | 'muted' } {
  if (r.aborted) return { label: t('ops.start.status.stopped'), tone: 'bad' }
  if (r.ok === true) return { label: t('ops.start.status.finished'), tone: 'ok' }
  if (r.ok === false) return { label: t('ops.start.status.failed'), tone: 'bad' }
  if (!r.endedAt) return { label: t('ops.start.status.unfinished'), tone: 'muted' }
  return { label: t('ops.start.status.ended'), tone: 'muted' }
}

// ── Icons ────────────────────────────────────────────────────────────────────

const PlayIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M8 5v14l11-7z" />
  </svg>
)
const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </svg>
)
const ShieldIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </svg>
)

// ── Mode ─────────────────────────────────────────────────────────────────────

/** Two radio options side by side; arrow keys move the choice, only the chosen one is a tab stop. */
function ModeControl({ labelledBy, mode, onChange }: { labelledBy: string; mode: Mode; onChange: (m: Mode) => void }) {
  const t = useT()
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + MODES.length) % MODES.length
    onChange(MODES[next])
    refs.current[next]?.focus()
  }
  return (
    <div className="ivs-seg" role="radiogroup" aria-labelledby={labelledBy}>
      {MODES.map((m, i) => (
        <button
          key={m}
          ref={(el) => {
            refs.current[i] = el
          }}
          type="button"
          role="radio"
          aria-checked={mode === m}
          tabIndex={mode === m ? 0 : -1}
          className={mode === m ? 'on' : ''}
          onClick={() => onChange(m)}
          onKeyDown={(e) => onKey(e, i)}
        >
          <span className="ivs-seg-title">{m === 'despiste' ? t('ops.start.mode.despiste') : t('ops.start.mode.runbook')}</span>
          <span className="ivs-seg-sub">{m === 'despiste' ? t('ops.start.mode.despisteSub') : t('ops.start.mode.runbookSub')}</span>
        </button>
      ))}
    </div>
  )
}

// ── The screen ───────────────────────────────────────────────────────────────

interface Props {
  /** Preselects this SSH host (the Ops button on a Remote & WSL row). */
  initialHostId?: string
  onStart: (intervention: OpsIntervention) => void
}

export default function InterventionStart({ initialHostId, onStart }: Props) {
  const t = useT()
  const { locale } = useLanguage()
  const [hosts, setHosts] = useState<SshHostPublic[] | null>(null)
  const [dots, setDots] = useState<Record<string, DotState>>({})
  const [server, setServer] = useState<ServerChoice>(initialHostId ?? null)

  /** Despiste on every mount, by decision: an intervention with a runbook is picked on purpose. */
  const [mode, setMode] = useState<Mode>('despiste')
  const builtin = useBuiltinRunbook()

  /** The runbooks folder, the loose runbooks and the runbook-mode choice. The choice survives
   *  a detour through despiste, and never holds the built-in path from a list. */
  const picker = useRunbookPicker({
    active: mode === 'runbook',
    hostId: typeof server === 'string' && server !== OPEN ? server : undefined,
    builtin
  })
  const { listed, infos, runbookPath, loadRunbook } = picker
  /** What the intervention starts with: the built-in runbook in despiste mode. */
  const activePath = mode === 'despiste' ? builtin : runbookPath

  const [task, setTask] = useState('')
  const [ticket, setTicket] = useState('')
  const [client, setClient] = useState(readLastClient)

  const [runs, setRuns] = useState<{ ok: true; runs: OpsRunListItem[] } | { ok: false; error: string } | 'loading'>('loading')
  const [reportFor, setReportFor] = useState<{ runId: string; runbookPath?: string; appSessionId?: string } | null>(null)

  const serverLabelId = useId()
  const modeLabelId = useId()
  const runbookLabelId = useId()
  const taskId = useId()
  const ticketId = useId()
  const clientId = useId()

  // Hosts, then a connection test of each so the list carries a live dot.
  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .sshList()
      .then((list) => {
        if (cancelled) return
        setHosts(list)
        setDots(Object.fromEntries(list.map((h) => [h.id, 'checking' as const])))
        for (const h of list) {
          window.electronAPI
            .sshTest(h.id)
            .then((res) => !cancelled && setDots((prev) => ({ ...prev, [h.id]: res.ok ? 'ok' : 'error' })))
            .catch(() => !cancelled && setDots((prev) => ({ ...prev, [h.id]: 'error' })))
        }
      })
      .catch(() => !cancelled && setHosts([]))
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (builtin) void loadRunbook(builtin)
  }, [builtin, loadRunbook])

  const scope: OpsScope | null =
    server === null ? null : server === OPEN ? { kind: 'open' } : { kind: 'host', hostId: server }
  const hostId = scope?.kind === 'host' ? scope.hostId : undefined

  // Earlier runs on the chosen server; every run when the scope is open or not chosen yet.
  useEffect(() => {
    let cancelled = false
    setRuns('loading')
    window.electronAPI
      .opsRuns({ hostId, limit: HISTORY_LIMIT })
      .then((res) => !cancelled && setRuns(res))
      .catch((e) => !cancelled && setRuns({ ok: false, error: e instanceof Error ? e.message : String(e) }))
    return () => {
      cancelled = true
    }
  }, [hostId])

  const selectedHost = hostId ? hosts?.find((h) => h.id === hostId) : undefined
  const info: InfoState | undefined = activePath ? infos[activePath] : undefined
  const loaded = info && info !== 'loading' ? info : undefined
  const okInfo = loaded?.ok ? loaded : undefined
  const summary = okInfo?.summary

  // ── Validation (inline) ────────────────────────────────────────────────────
  const hostProblem = runbookHostProblem(okInfo, scope, selectedHost?.name, t)

  const missing = [
    !scope && t('ops.start.needServer'),
    mode === 'runbook' && !runbookPath && t('ops.start.needRunbook')
  ].filter((m): m is string => !!m)
  // In despiste mode the built-in path arrives on its own; until it has loaded, it is loading.
  const blocked = !!hostProblem || (!!loaded && !loaded.ok) || info === 'loading' || (mode === 'despiste' && !info)
  const canStart = missing.length === 0 && !blocked

  const startHint = canStart
    ? t('ops.start.hintReady')
    : missing.length > 0
      ? t('ops.start.hintNeeded', {
          items: missing.length === 1
            ? missing[0]
            : t('ops.start.listAnd', { head: missing.slice(0, -1).join(', '), last: missing[missing.length - 1] })
        })
      : info === 'loading' || !info
        ? t('ops.start.hintLoading')
        : t('ops.start.hintFix')

  const start = () => {
    if (!canStart || !scope || !activePath) {
      return
    }
    const c = client.trim()
    const tk = ticket.trim()
    writeLastClient(c)
    // The built-in runbook is always one click away as the mode, so it is not remembered.
    if (mode === 'runbook' && !samePath(activePath, builtin)) writeLastRunbook(activePath)
    onStart({ runbookPath: activePath, scope, task: task.trim(), ...(tk ? { ticket: tk } : {}), ...(c ? { client: c } : {}) })
  }

  // ── Server field ───────────────────────────────────────────────────────────
  const hostRow = (h: SshHostPublic) => (
    <>
      <span className={`ivs-dot ${dots[h.id] ?? 'checking'}`} aria-hidden="true" />
      <span className="ivs-value">{h.name}</span>
      <span className="ivs-meta">{hostAddress(h)}</span>
    </>
  )
  const serverTrigger =
    server === OPEN ? (
      <span className="ivs-value">{t('ops.start.anyServer')}</span>
    ) : selectedHost ? (
      hostRow(selectedHost)
    ) : server && hosts ? (
      <span className="ivs-value">{t('ops.start.unknownServer')}</span>
    ) : (
      <span className="ivs-placeholder">{t('ops.start.chooseServer')}</span>
    )
  const serverItems: DropItem[] = [
    ...(hosts && hosts.length === 0
      ? [{ kind: 'note' as const, key: 'none', content: t('ops.start.noSshHosts') }]
      : (hosts ?? []).map((h) => ({
          kind: 'option' as const,
          key: h.id,
          selected: server === h.id,
          content: hostRow(h),
          onSelect: () => setServer(h.id)
        }))),
    { kind: 'divider', key: 'div' },
    {
      kind: 'option',
      key: OPEN,
      selected: server === OPEN,
      content: <span className="ivs-value">{t('ops.start.anyServer')}</span>,
      onSelect: () => setServer(OPEN)
    }
  ]
  const serverHelp =
    server === OPEN
      ? t('ops.start.helpOpen')
      : server
        ? t('ops.start.helpLocked')
        : t('ops.start.helpNone')

  // ── Right column ───────────────────────────────────────────────────────────
  const openFile = (file: 'RUNBOOK.md' | 'policy.json') => {
    if (activePath) void window.electronAPI.opsOpenRunbookFile(activePath, file)
  }

  /**
   * The folder a past run belongs to, so its report can name the host roles: a listed one,
   * or the built-in runbook. A bare built-in name is the built-in one unless a listed
   * folder carries that name too.
   */
  const runbookDirFor = (r: OpsRunListItem): string | undefined => {
    if (/[\\/]/.test(r.runbook)) {
      return builtin && (samePath(r.runbook, builtin) || OLD_BUILTIN_PATH_RE.test(r.runbook)) ? builtin : r.runbook
    }
    if (BUILTIN_NAMES.includes(r.runbook) && builtin && !listed.some((d) => baseName(d) === r.runbook)) return builtin
    return listed.find((d) => {
      const i = infos[d]
      return i && i !== 'loading' && i.ok && i.name === r.runbook
    })
  }

  const historyTitle = selectedHost ? t('ops.start.earlierOn', { name: selectedHost.name }) : t('ops.start.earlier')

  return (
    <div className="view ivs">
      <div className="ivs-scroll">
        <div className="ivs-grid">
          <div className="ivs-form">
            <div className="ivs-head">
              <h1 className="ivs-title">{t('ops.start.title')}</h1>
              <p className="ivs-sub">{mode === 'despiste' ? t('ops.start.subDespiste') : t('ops.start.sub')}</p>
            </div>

            <div className="ivs-field">
              <span className="ivs-label" id={serverLabelId}>
                {t('ops.start.server')}
              </span>
              <IvsDropdown labelledBy={serverLabelId} trigger={serverTrigger} items={serverItems} invalid={!!hostProblem} />
              {hostProblem ? (
                <span className="ivs-error" role="alert">
                  {hostProblem}
                </span>
              ) : (
                <span className="ivs-help">{serverHelp}</span>
              )}
            </div>

            <div className="ivs-field">
              <span className="ivs-label" id={modeLabelId}>
                {t('ops.start.mode')}
              </span>
              <ModeControl labelledBy={modeLabelId} mode={mode} onChange={setMode} />
              {mode === 'despiste' &&
                (loaded && !loaded.ok ? (
                  <span className="ivs-error" role="alert">
                    <strong>{t('ops.start.despisteUnusable')}</strong> {loaded.error}
                  </span>
                ) : (
                  <span className="ivs-help">{t('ops.start.despisteHelp')}</span>
                ))}
            </div>

            {mode === 'runbook' && (
              <div className="ivs-field">
                <span className="ivs-label" id={runbookLabelId}>
                  {t('ops.start.runbook')}
                </span>
                <RunbookField picker={picker} labelledBy={runbookLabelId} />
              </div>
            )}

            <div className="ivs-field">
              <label className="ivs-label" htmlFor={taskId}>
                {t('ops.start.task')} <span className="ivs-optional">{t('ops.start.optional')}</span>
              </label>
              <textarea
                id={taskId}
                className="ivs-control ivs-textarea"
                value={task}
                placeholder={t('ops.start.taskPlaceholder')}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault()
                    start()
                  }
                }}
              />
            </div>

            <div className="ivs-pair">
              <div className="ivs-field">
                <label className="ivs-label" htmlFor={ticketId}>
                  {t('ops.start.ticket')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                </label>
                <input
                  id={ticketId}
                  className="ivs-control ivs-input"
                  value={ticket}
                  onChange={(e) => setTicket(e.target.value)}
                  spellCheck={false}
                />
              </div>
              <div className="ivs-field">
                <label className="ivs-label" htmlFor={clientId}>
                  {t('ops.start.client')} <span className="ivs-optional">{t('ops.start.optional')}</span>
                </label>
                <input
                  id={clientId}
                  className="ivs-control ivs-input"
                  value={client}
                  onChange={(e) => setClient(e.target.value)}
                />
              </div>
            </div>

            <div className="ivs-actions">
              <button type="button" className="ivs-start" disabled={!canStart} onClick={start}>
                <PlayIcon />
                {mode === 'despiste' ? t('ops.start.startDespiste') : t('ops.start.startButton')}
              </button>
              <span className="ivs-help">{startHint}</span>
            </div>
          </div>

          <div className="ivs-side">
            <section className="ivs-panel" aria-labelledby={`${runbookLabelId}-allows`}>
              <h2 className="ivs-eyebrow" id={`${runbookLabelId}-allows`}>
                {mode === 'despiste' ? t('ops.start.despisteAllowsTitle') : t('ops.start.allowsTitle')}
              </h2>
              {!activePath ? (
                <p className="ivs-panel-text">{mode === 'despiste' ? t('common.loading') : t('ops.start.allowsChoose')}</p>
              ) : info === 'loading' || !info ? (
                <p className="ivs-panel-text">{t('common.loading')}</p>
              ) : !okInfo ? (
                <p className="ivs-panel-text">{t('ops.start.allowsFailed')}</p>
              ) : !summary ? (
                <p className="ivs-panel-text">
                  {plural(t, okInfo.strict ? 'ops.start.noSummaryStrict' : 'ops.start.noSummary', okInfo.hosts.length)}
                </p>
              ) : (
                <>
                  <div className="ivs-stats">
                    <div>
                      <div className="ivs-stat-n ok">{summary.autoReads}</div>
                      <div className="ivs-stat-l">
                        {plural(t, 'ops.start.stat.auto', summary.autoReads)}
                      </div>
                    </div>
                    <div>
                      <div className="ivs-stat-n warn">{summary.asks}</div>
                      <div className="ivs-stat-l">{plural(t, 'ops.start.stat.asks', summary.asks)}</div>
                    </div>
                    <div>
                      <div className="ivs-stat-n">{summary.mutates}</div>
                      <div className="ivs-stat-l">{plural(t, 'ops.start.stat.mutates', summary.mutates)}</div>
                    </div>
                  </div>
                  <p className="ivs-panel-text">
                    {summary.guidelinesHead.trim() ? (
                      <>
                        {rich(t('ops.start.guidelines'), {
                          text: withStop(summary.guidelinesHead),
                          file: <span className="ivs-mono">RUNBOOK.md</span>
                        })}
                      </>
                    ) : (
                      <>{rich(t('ops.start.noGuidelines'), { file: <span className="ivs-mono">RUNBOOK.md</span> })}</>
                    )}{' '}
                    {summary.scripts === 0 ? t('ops.start.noScripts') : plural(t, 'ops.start.scripts', summary.scripts)}
                    {mode !== 'despiste' && summary.readPaths.length > 0 && (
                      <>
                        {' '}
                        {rich(t('ops.start.readsAllowed'), {
                          paths: joinAnd(
                            summary.readPaths.map((p) => (
                              <span key={p} className="ivs-mono">
                                {p}
                              </span>
                            )),
                            t
                          )
                        })}
                      </>
                    )}
                  </p>
                </>
              )}
              {mode === 'despiste' && okInfo && <p className="ivs-panel-text">{t('ops.start.despisteLeftOut')}</p>}
              {okInfo && (
                <div className="ivs-file-buttons">
                  <button type="button" className="ivs-btn" onClick={() => openFile('RUNBOOK.md')}>
                    <FileIcon />
                    RUNBOOK.md
                  </button>
                  <button type="button" className="ivs-btn" onClick={() => openFile('policy.json')}>
                    <ShieldIcon />
                    policy.json
                  </button>
                </div>
              )}
            </section>

            <section className="ivs-history" aria-label={historyTitle}>
              <h2 className="ivs-eyebrow">{historyTitle}</h2>
              {runs === 'loading' ? (
                <p className="ivs-help">{t('common.loading')}</p>
              ) : !runs.ok ? (
                <p className="ivs-error">{runs.error}</p>
              ) : runs.runs.length === 0 ? (
                <p className="ivs-help">
                  {selectedHost ? t('ops.start.noneOn', { name: selectedHost.name }) : t('ops.start.none')}
                </p>
              ) : (
                <div className="ivs-runs">
                  {runs.runs.map((r) => {
                    const st = runStatus(r, t)
                    const dir = runbookDirFor(r)
                    const label = interventionLabel(
                      {
                        runbook: r.runbook,
                        builtin: samePath(dir, builtin),
                        server:
                          r.hostNames.length === 1 ? { kind: 'host', name: r.hostNames[0] } : { kind: 'open', reached: r.hostNames },
                        task: r.task
                      },
                      t
                    )
                    return (
                      <div key={r.runId} className="ivs-run" role="group">
                        <span className="ivs-run-when" title={new Date(r.startedAt).toLocaleString(locale)}>
                          {runWhen(r.startedAt, t, locale)}
                        </span>
                        <span className="ivs-run-what" title={label.tooltip}>
                          <span className="ivs-run-what-text">{r.task || label.title}</span>
                          <InterventionTag label={label} />
                        </span>
                        <span className={`ivs-run-status ${st.tone}`}>{st.label}</span>
                        <button
                          type="button"
                          className="ivs-btn small"
                          onClick={() => setReportFor({ runId: r.runId, runbookPath: dir, appSessionId: r.appSessionId })}
                        >
                          {t('ops.start.report')}
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>

      {reportFor && (
        <OpsReportSheet
          runId={reportFor.runId}
          appSessionId={reportFor.appSessionId}
          runbookPath={reportFor.runbookPath}
          onClose={() => setReportFor(null)}
        />
      )}
    </div>
  )
}
