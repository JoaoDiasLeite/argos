import './PendingRuns.css'
import { SESSION_DRAG_TYPE } from '../lib/pane-drop'

export interface PendingRun {
  /** The app session id of the chat that's still working. */
  id: string
  name: string
  /** True when the run is parked on a tool approval rather than just thinking. */
  attention?: boolean
  /** The run is over and its result hasn't been read yet. */
  done?: boolean
  /** Account the run is billed to, set only when it disambiguates — see App.tsx's
      pendingRuns. Undefined means "the account you're already on". */
  account?: string
}

interface Props {
  runs: PendingRun[]
  onOpen: (id: string) => void
  onDismiss: (id: string) => void
  /** Same contract as Sidebar's `onSessionDrag`: the chat being dragged, or null when it ends. */
  onDrag?: (id: string | null) => void
}

/**
 * Window-wide strip listing chats whose request is still in flight, so you can leave a chat
 * running, go do something else, and still find your way back — the same role the server-tabs
 * strip plays for remote sessions. Chats that finished while you were away stay on, marked
 * done, until you open them. Dismissing a working one only hides it from this banner, it
 * never stops the run (that's the chat's own stop button), and it reappears the next time
 * the chat starts a request — see how endRun clears the dismissed set. Dismissing a done
 * one marks it read.
 */
export default function PendingRuns({ runs, onOpen, onDismiss, onDrag }: Props) {
  if (runs.length === 0) return null

  // What needs you first, then what is still working, finished last. Stable within a group.
  const rank = (r: PendingRun) => (r.done ? 2 : r.attention ? 0 : 1)
  const ordered = [...runs].sort((a, b) => rank(a) - rank(b))

  return (
    <div className="pending-runs">
      {ordered.map((r, i) => (
        <span
          key={r.id}
          className={`pending-run ${r.done ? 'done' : r.attention ? 'attention' : 'working'}${
            r.done && i > 0 && !ordered[i - 1].done ? ' first-done' : ''
          }`}
          /* Dragging a pill onto the panes opens that chat beside the one on screen, exactly
             like dragging a sidebar row (see PaneGrid). For a chat on another account this is
             the only way to do it: the sidebar lists just the account you're on, and this bar
             is where every other account's runs surface. */
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SESSION_DRAG_TYPE, r.id)
            e.dataTransfer.effectAllowed = 'move'
            onDrag?.(r.id)
          }}
          onDragEnd={() => onDrag?.(null)}
        >
          <button
            type="button"
            className="pending-run-open"
            onClick={() => onOpen(r.id)}
            title={[
              r.name,
              r.account ? `on ${r.account}` : null,
              r.done ? 'finished, not read yet' : r.attention ? 'waiting for your input' : 'working'
            ]
              .filter(Boolean)
              .join(' · ')}
          >
            {/* One state per pill, in the sidebar's own language: a halo while it works,
                amber when it waits for you, a tick once it is over. */}
            {r.done ? (
              <svg className="pending-run-tick" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            ) : (
              <i className="pending-run-dot" aria-hidden="true" />
            )}
            <span className="pending-run-name">{r.name}</span>
            {r.account && <span className="pending-run-account">{r.account}</span>}
          </button>
          <button
            type="button"
            className="pending-run-close"
            onClick={() => onDismiss(r.id)}
            title={r.done ? 'Mark as read' : 'Hide from this bar (the chat keeps running)'}
            aria-label={r.done ? `Mark ${r.name} as read` : `Hide ${r.name} from the pending bar`}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
    </div>
  )
}
