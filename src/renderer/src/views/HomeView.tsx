import './views.css'
import './HomeView.css'

export interface HomeApproval {
  approvalId: string
  sessionId: string
  sessionName: string
  projectName?: string
  tool: string
  target: string
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
  path: string
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

export interface HomeRecent {
  id: string
  name: string
  projectName?: string
  updatedAt: number
  preview: string
}

interface Props {
  approvals: HomeApproval[]
  running: HomeRunning[]
  repos: HomeRepo[]
  plans: HomePlan[]
  todayCost: number | null
  todayChats: number | null
  recent: HomeRecent[]
  onOpenSession: (id: string) => void
  onOpenRepo: (path: string) => void
  onOpenUsage: () => void
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

function formatDollars(v: number): string {

  return `$${v.toFixed(2)}`
}

function ReviewIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
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

export default function HomeView({
  approvals,
  running,
  repos,
  plans,
  todayCost,
  todayChats,
  recent,
  onOpenSession,
  onOpenRepo,
  onOpenUsage
}: Props) {
  const nothing =
    approvals.length === 0 &&
    running.length === 0 &&
    repos.length === 0 &&
    plans.length === 0 &&
    todayCost === null &&
    recent.length === 0

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Home</h1>
          <p className="view-sub">
            {approvals.length === 0
              ? 'Nothing waiting on you right now.'
              : approvals.length === 1
                ? '1 thing needs you'
                : `${approvals.length} things need you`}
          </p>
        </div>
      </div>

      {nothing ? (
        <div className="view-empty">
          <span className="view-empty-msg">
            Nothing to show yet. Once you start a chat or a project picks up uncommitted
            work, it will show up here.
          </span>
        </div>
      ) : (
        <div className="view-scroll">
          {approvals.length > 0 && (
            <section className="home-section home-section--attention" aria-label="Needs you">
              <h2 className="home-section-title">Needs you</h2>
              <div className="home-list">
                {approvals.map((a) => (
                  <div key={a.approvalId} className="home-row home-approval-row">
                    <div className="home-row-main">
                      <div className="home-row-top">
                        <span className="home-row-name">{a.sessionName}</span>
                        {a.projectName && <span className="home-row-project">{a.projectName}</span>}
                      </div>
                      <div className="home-approval-cmd">
                        {a.tool} · {a.target}
                      </div>
                    </div>
                    <button
                      className="btn-ghost small home-review-btn"
                      onClick={() => onOpenSession(a.sessionId)}
                    >
                      <ReviewIcon />
                      Review
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

          {repos.length > 0 && (
            <section className="home-section" aria-label="Uncommitted work">
              <h2 className="home-section-title">Uncommitted work</h2>
              <div className="home-list">
                {repos.map((r) => (
                  <div key={r.path} className="home-row home-repo-row">
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
                      <button className="btn-ghost small" onClick={() => onOpenRepo(r.path)}>
                        <FolderIcon />
                        {r.fileCount === 1 ? '1 file' : `${r.fileCount} files`}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {(plans.length > 0 || todayCost !== null) && (
            <section className="home-section" aria-label="Usage">
              <h2 className="home-section-title">Usage</h2>
              <div className="home-cards">
                {plans.map((p) => (
                  <button key={p.accountKey} className="home-card" onClick={onOpenUsage}>
                    <span className="home-card-label">{p.accountName}</span>
                    <span className="home-card-value">
                      {p.percent === null ? '—' : `${Math.round(p.percent)}%`}
                    </span>
                    {fmtReset(p.resetsAt) && <span className="home-card-sub">{fmtReset(p.resetsAt)}</span>}
                    {p.stale && <span className="home-card-stale">stale</span>}
                  </button>
                ))}
                {todayCost !== null && (
                  <button className="home-card" onClick={onOpenUsage}>
                    <span className="home-card-label">Today</span>
                    <span className="home-card-value">{formatDollars(todayCost)}</span>
                    {todayChats !== null && (
                      <span className="home-card-sub">
                        {todayChats === 1 ? '1 chat' : `${todayChats} chats`}
                      </span>
                    )}
                  </button>
                )}
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
      )}
    </div>
  )
}
