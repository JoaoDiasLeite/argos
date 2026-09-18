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

  const doneCount = runs.filter((r) => r.done).length
  const workingCount = runs.length - doneCount
  const label = [
    workingCount ? `${workingCount} chat${workingCount === 1 ? '' : 's'} working` : null,
    doneCount ? `${doneCount}${workingCount ? '' : ` chat${doneCount === 1 ? '' : 's'}`} finished` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="pending-runs">
      <span className="pending-runs-label">
        {workingCount > 0 ? (
          <svg className="pending-runs-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.22-8.56" />
          </svg>
        ) : (
          <CheckIcon />
        )}
        {label}
      </span>
      {runs.map((r) => (
        <span
          key={r.id}
          className={`pending-run ${r.attention ? 'attention' : ''} ${r.done ? 'done' : ''}`}
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
            className="pending-run-open"
            onClick={() => onOpen(r.id)}
            title={[
              r.name,
              r.account ? `on ${r.account}` : null,
              r.done ? 'finished — not read yet' : r.attention ? 'waiting for your approval' : null
            ]
              .filter(Boolean)
              .join(' — ')}
          >
            {r.done && <CheckIcon />}
            {r.name}
            {r.account && <span className="pending-run-account">{r.account}</span>}
            {r.done ? (
              <span className="pending-run-note done">finished</span>
            ) : (
              r.attention && <span className="pending-run-note">needs approval</span>
            )}
          </button>
          <button
            className="pending-run-close"
            onClick={() => onDismiss(r.id)}
            title={r.done ? 'Mark as read' : 'Hide from this bar (the chat keeps running)'}
            aria-label={r.done ? `Mark ${r.name} as read` : `Hide ${r.name} from the pending bar`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}

function CheckIcon() {
  return (
    <svg className="pending-run-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
