import { useEffect, useState } from 'react'
import { LiveSession } from '../types'
import './views.css'
import './LiveView.css'

/**
 * Local to this file on purpose — ProjectsView has its own `timeAgo`, and exporting
 * one across files to save a dozen lines is exactly the coupling convention 1 warns
 * against for code that doesn't need to be shared.
 */
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

/** How long a session has been running, from `startedAt` — always relative to now,
 *  so unlike `timeAgo` above it never falls back to a calendar date. */
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

/** Last path segment of a cwd, for the row title — the full path lives in the
 *  row's `title` tooltip (see `.project-row` in ProjectsView for the same split). */
function lastSegment(p: string): string {
  return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
}

const STATUS_LABEL: Record<LiveSession['status'], string> = {
  busy: 'Busy',
  idle: 'Idle',
  unknown: 'Unknown'
}

function StatusPill({ status }: { status: LiveSession['status'] }) {
  return <span className={`status-pill live-status-${status}`}>{STATUS_LABEL[status]}</span>
}

export default function LiveView() {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    const list = await window.electronAPI.ccLiveSessions()
    setSessions(list)
    setLoading(false)
  }

  useEffect(() => {
    load()
    // A status view, not a log: 10s keeps the pills current without polling like
    // something that needs to catch every transition.
    const t = setInterval(load, 10000)
    const onFocus = () => load()
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  return (
    <div className="view">
      <div className="view-header">
        <div>
          <h1>Live sessions</h1>
          <p className="view-sub">
            claude processes running on this machine right now, read from Claude Code's own
            registry — including ones started outside Argos.
          </p>
        </div>
        <div className="header-actions">
          <button className="btn-ghost" onClick={load} title="Refresh">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10" />
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
            </svg>
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <div className="view-loading">
          <div className="view-spinner" />
          <span className="view-loading-text">Loading live sessions…</span>
        </div>
      ) : sessions.length === 0 ? (
        <div className="view-empty">
          <span className="view-empty-msg">
            No live sessions right now. A claude process started outside Argos — from a
            terminal, or another machine's SSH session — shows up here too, so an empty list
            means none is running, not that this view can't see it.
          </span>
        </div>
      ) : (
        <div className="view-scroll">
          {/* Said once, above the rows. Repeating it on each foreign row buried the
              rows themselves — six copies of one sentence is not six times as clear. */}
          {sessions.some((s) => s.foreign) && (
            <p className="live-foreign-note">
              Rows marked <b>Foreign</b> are real and running, but their pid belongs to
              another process space — a WSL distro's, or another user's. The same number
              here names an unrelated process, so these can never be signalled from Argos.
            </p>
          )}
          <div className="live-rows">
            {sessions.map((s) => (
              <div
                key={`${s.sourceId}:${s.pid}:${s.sessionId}`}
                className={`live-row ${s.foreign ? 'foreign' : ''}`}
              >
                <div className="live-row-main">
                  <div className="live-row-top">
                    <span className="live-row-name">{s.name}</span>
                    <StatusPill status={s.status} />
                    {s.foreign && (
                      <span
                        className="live-row-foreign-badge"
                        title="This pid belongs to another process space, so it can never be signalled from here."
                      >
                        Foreign
                      </span>
                    )}
                  </div>
                  <div className="live-row-cwd" title={s.cwd}>
                    {lastSegment(s.cwd)}
                  </div>
                </div>
                <div className="live-row-meta">
                  {s.sourceLabel && s.sourceId !== 'local' && (
                    <span className="live-row-source">{s.sourceLabel}</span>
                  )}
                  {duration(s.startedAt) && <span>running {duration(s.startedAt)}</span>}
                  {/* Both halves are optional: an entry can carry neither timestamp,
                      and a bare "updated" with nothing after it reads as a bug. */}
                  {duration(s.startedAt) && timeAgo(s.updatedAt) && <span>·</span>}
                  {timeAgo(s.updatedAt) && <span>updated {timeAgo(s.updatedAt)}</span>}
                  <span className="live-row-pid">pid {s.pid}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
