import { useEffect, useState } from 'react'
import { LiveSession, TakeoverRefusal } from '../types'
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

/** One sentence per refusal, written for the person clicking the button rather than
 *  for a log — several of these are the safety machinery working correctly, not a
 *  failure, and the copy says so rather than reading as a generic error. */
function takeoverRefusalMessage(error: TakeoverRefusal, detail?: string): string {
  switch (error) {
    case 'not-found':
      return 'This session already ended — the registry no longer lists it. Refresh to drop it from view.'
    case 'foreign':
      // Unreachable from this UI: no takeover control is ever rendered on a foreign
      // row. Kept in case the guard is somehow reached another way.
      return 'This pid belongs to another process space, so it can never be signalled from here.'
    case 'pid-changed':
      return 'This session has restarted under a new pid since this row was drawn — the click was aimed at a process that is already gone. Refresh and try again.'
    case 'no-proc-start':
      return 'The registry has no start time recorded for this session, so Argos cannot rule out the pid having been recycled. It refuses rather than signalling unguarded.'
    case 'not-running':
    case 'unverifiable':
      return 'Argos could not establish what process currently holds this pid, so it refuses rather than guessing.'
    case 'pid-reused':
      return 'The process holding this pid now started at a different time than the session recorded — it is a different process wearing the old one’s number. The guard caught this on purpose.'
    case 'not-claude':
      return 'The process holding this pid is not claude.'
    case 'failed':
    default:
      return detail || 'The takeover failed.'
  }
}

export default function LiveView() {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [loading, setLoading] = useState(true)
  /** Row key of the one confirmation open at a time, `null` when none is. */
  const [confirmKey, setConfirmKey] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  /** Row keys whose process has been asked to exit but may still be listed by the
   *  next refresh — see the comment above `load` for why this outlives the request. */
  const [endingKeys, setEndingKeys] = useState<Set<string>>(new Set())
  const [rowError, setRowError] = useState<{ key: string; message: string; canRetryRefresh: boolean } | null>(
    null
  )

  const rowKey = (s: LiveSession) => `${s.sourceId}:${s.pid}:${s.sessionId}`

  const load = async () => {
    const list = await window.electronAPI.ccLiveSessions()
    setSessions(list)
    setLoading(false)
    // Once a row genuinely drops off the registry, its "ending…" flag can go with
    // it — keeping it around forever would only grow a set nothing reads again.
    const live = new Set(list.map(rowKey))
    setEndingKeys((prev) => {
      const next = new Set([...prev].filter((k) => live.has(k)))
      return next.size === prev.size ? prev : next
    })
  }

  const openConfirm = (key: string) => {
    setRowError(null)
    setConfirmKey((k) => (k === key ? null : key))
  }

  const cancelConfirm = () => {
    setConfirmKey(null)
    setRowError(null)
  }

  const doTakeover = async (s: LiveSession) => {
    const key = rowKey(s)
    setBusyKey(key)
    setRowError(null)
    const res = await window.electronAPI.ccTakeoverSession(s.sourceId, s.sessionId, s.pid)
    setBusyKey(null)
    if (!res.ok) {
      setRowError({
        key,
        message: takeoverRefusalMessage(res.error, res.detail),
        // These two are stale-list refusals: the fix is always the same button.
        canRetryRefresh: res.error === 'pid-changed' || res.error === 'not-found'
      })
      return
    }
    // Asked to exit, not killed — it does not vanish instantly. The row stays put
    // and reads "ending…" rather than disappearing and possibly reappearing, which
    // would look like a glitch; it drops off the list on its own once a refresh
    // finds the process really gone.
    setConfirmKey(null)
    setEndingKeys((prev) => new Set(prev).add(key))
    load()
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
            {sessions.map((s) => {
              const key = rowKey(s)
              const ending = endingKeys.has(key)
              const confirming = confirmKey === key
              const busy = busyKey === key
              const err = rowError && rowError.key === key ? rowError : null
              return (
                <div
                  key={key}
                  className={`live-row ${s.foreign ? 'foreign' : ''} ${ending ? 'ending' : ''}`}
                >
                  <div className="live-row-top-line">
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
                        {ending && (
                          <span className="live-row-ending-badge">Ending…</span>
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
                    {/* Never rendered on a foreign row — round 1 already tells the user
                        those can never be signalled, and a disabled button here would
                        contradict that rather than confirm it. */}
                    {!s.foreign && !ending && (
                      <button
                        className="live-takeover-btn"
                        onClick={() => openConfirm(key)}
                        aria-expanded={confirming}
                        title="End this session outside Argos so it can be resumed here"
                      >
                        Take over
                      </button>
                    )}
                  </div>

                  {confirming && (
                    <div className="live-confirm">
                      <p>
                        Ask <b>{s.name}</b> (pid {s.pid}) in{' '}
                        <span className="live-confirm-path">{s.cwd}</span> to exit?
                      </p>
                      <p className="live-confirm-note">
                        Argos sends a request to exit, not a kill: the process gets to write
                        its transcript out and clean up, and Argos never escalates if it
                        declines. Once it exits, this conversation can be resumed in Argos.
                        Anything unsaved in that terminal itself — a half-typed prompt, the
                        scrollback — is gone.
                      </p>
                      {err && (
                        <div className="live-confirm-error">
                          <span>{err.message}</span>
                          {err.canRetryRefresh && (
                            <button className="btn-ghost small" onClick={load}>
                              Refresh
                            </button>
                          )}
                        </div>
                      )}
                      <div className="live-confirm-actions">
                        <button className="btn-ghost small" onClick={cancelConfirm} disabled={busy}>
                          Cancel
                        </button>
                        <button
                          className="btn-primary small danger"
                          onClick={() => doTakeover(s)}
                          disabled={busy}
                        >
                          {busy ? 'Ending…' : 'End session'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
