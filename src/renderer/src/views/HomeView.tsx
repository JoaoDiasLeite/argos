import { useState } from 'react'
import './views.css'
import './HomeView.css'

export interface HomeAttention {
  id: string
  kind: 'approval' | 'routine'
  title: string
  detail: string
  mono?: boolean
  context?: string
  since?: number
  actionLabel: string
}

export interface HomeRunning {
  id: string
  kind: 'chat' | 'cli'
  name: string
  detail?: string
  startedAt?: number
  attention?: boolean
}

export interface HomeRepo {
  key: string
  name: string
  branch?: string
  fileCount: number
  loading?: boolean
  error?: string
}

export interface HomePlan {
  accountKey: string
  accountName: string
  percent: number | null
  resetsAt?: string
  stale?: boolean
}

export interface HomeSpend {
  today: number
  days: { day: string; costUsd: number }[]
}

export interface HomeRoutine {
  id: string
  name: string
  nextRunAt?: number
  cadence: string
}

export interface HomeRecent {
  id: string
  name: string
  projectName?: string
  updatedAt: number
  preview: string
}

export interface HomeStart {
  projectName?: string
  modelLabel?: string
  accountName?: string
}

interface Props {
  attention: HomeAttention[]
  running: HomeRunning[]
  repos: HomeRepo[]
  plans: HomePlan[]
  spend: HomeSpend | null
  routines: HomeRoutine[]
  recent: HomeRecent[]
  start: HomeStart
  onAct: (id: string) => void
  onStart: (prompt: string) => void
  onOpenSession: (id: string) => void
  onOpenRepo: (key: string) => void
  onOpenUsage: () => void
  onOpenScheduled: () => void
}

/** Own copy on purpose — see LiveView's `timeAgo` for why this isn't shared across
 *  files (convention 1: no cross-file coupling to save a few lines). */
function timeAgo(ts: number): string {
  if (!ts) return ''
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** How long a run has been going, from `startedAt`. Own copy — see LiveView's
 *  `duration` and ProjectsView's own version, this file's is the third by convention. */
function duration(startedAt: number): string {
  if (!startedAt) return ''
  const diff = Math.max(0, Date.now() - startedAt)
  const m = Math.floor(diff / 60000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rem = m % 60
  if (h < 24) return rem ? `${h}h ${rem}m` : `${h}h`
  const d = Math.floor(h / 24)
  return `${d}d`
}

/** "resets in 3h 12m" / "resets Mon 14:00" for a plan window's reset timestamp. Own
 *  copy of UsageView's formatter by the same convention as `timeAgo` above — the raw
 *  ISO string is unreadable on a card, and the two views are free to diverge. */
function fmtReset(iso?: string): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (!isFinite(t)) return ''
  const mins = Math.round((t - Date.now()) / 60000)
  if (mins <= 0) return 'resets soon'
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`
  const d = new Date(t)
  return `resets ${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

/** "waiting 40s" / "waiting 4m" for how long an attention item has been sitting there. */
function waitingFor(since?: number): string {
  if (!since) return ''
  const diff = Math.max(0, Date.now() - since)
  const s = Math.floor(diff / 1000)
  if (s < 60) return `waiting ${s}s`
  return `waiting ${Math.floor(s / 60)}m`
}

/** "in 2h" / "tomorrow 03:00" / "overdue" for a routine's next run. */
function nextRun(ts?: number): string {
  if (!ts) return ''
  const diff = ts - Date.now()
  if (diff <= 0) return 'overdue'
  const mins = Math.round(diff / 60000)
  if (mins < 60) return `in ${mins}m`
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return `in ${hours}h`
  const d = new Date(ts)
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, tomorrow)) {
    return `tomorrow ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  }
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}

function formatDollars(v: number): string {
  return `$${v.toFixed(2)}`
}

function TerminalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function AlertIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function ScheduleIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

/** Inline SVG mini bar chart for the last N days of spend — no charting library, just
 *  a percentage-based viewBox so it scales with the card regardless of rendered width. */
function SpendChart({ days }: { days: HomeSpend['days'] }) {
  if (days.length === 0) return null
  const max = Math.max(1e-6, ...days.map((d) => d.costUsd))
  const n = days.length
  const slot = 100 / n
  const barW = slot * 0.6
  return (
    <svg
      className="home-spend-chart"
      viewBox="0 0 100 26"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Daily spend, last ${n} days`}
    >
      {days.map((d, i) => {
        // A zero-cost day still gets a 1px sliver so the bar doesn't vanish from the row.
        const h = Math.max(1, (d.costUsd / max) * 26)
        const x = i * slot + (slot - barW) / 2
        const isLast = i === n - 1
        return (
          <rect
            key={d.day}
            x={x}
            y={26 - h}
            width={barW}
            height={h}
            rx={0.6}
            fill={isLast ? 'var(--accent)' : 'var(--bg-3)'}
          />
        )
      })}
    </svg>
  )
}

function AttentionIcon({ kind, mono }: { kind: HomeAttention['kind']; mono?: boolean }) {
  if (mono) return <TerminalIcon />
  if (kind === 'routine') return <AlertIcon />
  return <DocIcon />
}

export default function HomeView({
  attention,
  running,
  repos,
  plans,
  spend,
  routines,
  recent,
  start,
  onAct,
  onStart,
  onOpenSession,
  onOpenRepo,
  onOpenUsage,
  onOpenScheduled
}: Props) {
  const [prompt, setPrompt] = useState('')

  const nothing =
    attention.length === 0 &&
    running.length === 0 &&
    repos.length === 0 &&
    plans.length === 0 &&
    spend === null &&
    routines.length === 0 &&
    recent.length === 0

  const dirtyCount = repos.filter((r) => !r.loading && !r.error && r.fileCount > 0).length
  const todayLabel = new Date().toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  function submitStart() {
    const trimmed = prompt.trim()
    if (!trimmed) return
    onStart(trimmed)
    setPrompt('')
  }

  return (
    <div className="view">
      <div className="view-header home-header">
        <div>
          <h1>Home</h1>
          <p className="view-sub">{todayLabel}</p>
        </div>
        <div className="home-header-chips">
          {attention.length > 0 && (
            <span className="home-chip home-chip--warn">
              {attention.length === 1 ? '1 needs you' : `${attention.length} need you`}
            </span>
          )}
          {running.length > 0 && (
            <span className="home-chip">{running.length === 1 ? '1 running' : `${running.length} running`}</span>
          )}
          {dirtyCount > 0 && (
            <span className="home-chip">{dirtyCount === 1 ? '1 dirty' : `${dirtyCount} dirty`}</span>
          )}
        </div>
      </div>

        <div className="view-scroll">
          <div className="home-start">
            <textarea
              aria-label="What are we doing?"
              className="home-start-input"
              placeholder="What are we doing?"
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submitStart()
                }
              }}
            />
            <div className="home-start-row">
              <div className="home-start-chips">
                {start.projectName && <span className="home-start-chip">{start.projectName}</span>}
                {start.modelLabel && <span className="home-start-chip">{start.modelLabel}</span>}
                {start.accountName && <span className="home-start-chip">{start.accountName}</span>}
              </div>
              <button
                className="btn-primary home-start-btn"
                disabled={!prompt.trim()}
                onClick={submitStart}
              >
                Start
              </button>
            </div>
          </div>

          {nothing ? (
            <div className="view-empty">
              <span className="view-empty-msg">
                Nothing running, nothing waiting. Start something above.
              </span>
            </div>
          ) : (
          <div className="home-grid">
            <div className="home-col">
              {attention.length > 0 && (
                <section className="home-section home-section--attention" aria-label="Needs you">
                  <h2 className="home-section-title">Needs you</h2>
                  <div className="home-attention-block">
                    {attention.map((a) => (
                      <div key={a.id} className="home-attention-row">
                        <span className="home-attention-icon" aria-hidden="true">
                          <AttentionIcon kind={a.kind} mono={a.mono} />
                        </span>
                        <div className="home-row-main">
                          <span className="home-row-name">{a.title}</span>
                          <span className={`home-attention-detail ${a.mono ? 'mono' : ''}`}>{a.detail}</span>
                          {(a.context || a.since) && (
                            <span className="home-attention-meta">
                              {a.context}
                              {a.context && a.since ? ' · ' : ''}
                              {waitingFor(a.since)}
                            </span>
                          )}
                        </div>
                        <button className="btn-ghost small home-attention-btn" onClick={() => onAct(a.id)}>
                          {a.actionLabel}
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {running.length > 0 && (
                <section className="home-section" aria-label="Running">
                  <h2 className="home-section-title">Running</h2>
                  <div className="home-list">
                    {running.map((r) => {
                      const clickable = r.kind === 'chat'
                      const dur = r.startedAt ? duration(r.startedAt) : ''
                      return (
                        <div
                          key={r.id}
                          className={`home-row home-running-row ${r.attention ? 'attention' : ''} ${clickable ? 'clickable' : ''}`}
                          onClick={clickable ? () => onOpenSession(r.id) : undefined}
                          role={clickable ? 'button' : undefined}
                          tabIndex={clickable ? 0 : undefined}
                          onKeyDown={
                            clickable
                              ? (e) => {
                                  if (e.key === 'Enter' || e.key === ' ') onOpenSession(r.id)
                                }
                              : undefined
                          }
                        >
                          <span className={`home-dot ${r.attention ? 'attention' : 'running'}`} aria-hidden="true" />
                          <span className="home-row-name">{r.name}</span>
                          <span className="home-running-kind">{r.kind === 'chat' ? 'Chat' : 'CLI'}</span>
                          <span className="home-running-spacer" />
                          {r.detail && <span className="home-running-detail">{r.detail}</span>}
                          {dur && <span className="home-running-duration">{dur}</span>}
                        </div>
                      )
                    })}
                  </div>
                </section>
              )}

              {recent.length > 0 && (
                <section className="home-section" aria-label="Pick up where you left off">
                  <h2 className="home-section-title">Pick up where you left off</h2>
                  <div className="home-list">
                    {recent.map((r) => (
                      <div
                        key={r.id}
                        className="home-row home-recent-row clickable"
                        onClick={() => onOpenSession(r.id)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') onOpenSession(r.id)
                        }}
                      >
                        <div className="home-row-main">
                          <div className="home-row-top">
                            <span className="home-row-name">{r.name}</span>
                            {r.projectName && <span className="home-row-project">{r.projectName}</span>}
                            <span className="home-recent-time">{timeAgo(r.updatedAt)}</span>
                          </div>
                          <div className="home-recent-preview">{r.preview}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <div className="home-col">
              {(plans.length > 0 || spend !== null) && (
                <section className="home-section" aria-label="Plan and spend">
                  <h2 className="home-section-title">Plan &amp; spend</h2>
                  <button className="home-plan-card" onClick={onOpenUsage}>
                    {plans.map((p) => (
                      <div key={p.accountKey} className="home-plan-row">
                        <div className="home-plan-top">
                          <span className="home-plan-name">{p.accountName}</span>
                          {p.percent === null ? (
                            <span className="home-plan-nodata">no data</span>
                          ) : (
                            <span className="home-plan-percent">{Math.round(p.percent)}%</span>
                          )}
                        </div>
                        {p.percent !== null && (
                          <div className="home-plan-bar-track">
                            <div
                              className="home-plan-bar-fill"
                              style={{ width: `${Math.min(100, Math.max(0, p.percent))}%` }}
                            />
                          </div>
                        )}
                        {(fmtReset(p.resetsAt) || p.stale) && (
                          <span className="home-plan-sub">
                            {fmtReset(p.resetsAt)}
                            {p.stale ? ' · stale' : ''}
                          </span>
                        )}
                      </div>
                    ))}

                    {spend !== null && (
                      <>
                        {plans.length > 0 && <div className="home-plan-sep" />}
                        <div className="home-spend-top">
                          <span className="home-plan-name">Today</span>
                          <span className="home-plan-percent">{formatDollars(spend.today)}</span>
                        </div>
                        <SpendChart days={spend.days} />
                      </>
                    )}
                  </button>
                </section>
              )}

              {routines.length > 0 && (
                <section className="home-section" aria-label="Next up">
                  <div className="home-section-title-row">
                    <h2 className="home-section-title">Next up</h2>
                    <button className="home-section-action" onClick={onOpenScheduled}>
                      <ScheduleIcon />
                      Scheduled
                    </button>
                  </div>
                  <div className="home-list">
                    {routines.map((r) => (
                      <div key={r.id} className="home-row home-routine-row">
                        <div className="home-row-main">
                          <span className="home-row-name">{r.name}</span>
                          <span className="home-routine-sub">
                            {nextRun(r.nextRunAt)}
                            {nextRun(r.nextRunAt) ? ' · ' : ''}
                            {r.cadence}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {repos.length > 0 && (
                <section className="home-section" aria-label="Uncommitted work">
                  <h2 className="home-section-title">Uncommitted work</h2>
                  <div className="home-list">
                    {repos.map((r) => (
                      <div key={r.key} className="home-row home-repo-row">
                        <div className="home-row-main">
                          <div className="home-row-top">
                            <span className="home-row-name">{r.name}</span>
                            {r.branch && <span className="home-row-project">{r.branch}</span>}
                          </div>
                          {r.error && (
                            <div className="home-repo-error" role="alert">
                              {r.error}
                            </div>
                          )}
                        </div>
                        {r.loading ? (
                          <span className="home-repo-loading">
                            <span className="view-spinner small" />
                          </span>
                        ) : r.error ? null : r.fileCount === 0 ? (
                          <span className="home-repo-clean">clean</span>
                        ) : (
                          <button className="btn-ghost small" onClick={() => onOpenRepo(r.key)}>
                            <FolderIcon />
                            {r.fileCount === 1 ? '1 file' : `${r.fileCount} files`}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          </div>
          )}
        </div>
    </div>
  )
}
