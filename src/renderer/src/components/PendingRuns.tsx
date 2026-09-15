import './PendingRuns.css'

export interface PendingRun {
  /** The app session id of the chat that's still working. */
  id: string
  name: string
  /** True when the run is parked on a tool approval rather than just thinking. */
  attention?: boolean
  /** Account the run is billed to, set only when it disambiguates — see App.tsx's
      pendingRuns. Undefined means "the account you're already on". */
  account?: string
}

interface Props {
  runs: PendingRun[]
  onOpen: (id: string) => void
  onDismiss: (id: string) => void
}

/**
 * Window-wide strip listing chats whose request is still in flight, so you can leave a chat
 * running, go do something else, and still find your way back — the same role the server-tabs
 * strip plays for remote sessions. Each entry is individually dismissible: hiding one is only
 * about this banner, it never stops the run (that's the chat's own stop button). A dismissed
 * chat reappears the next time it starts a request — see how endRun clears the dismissed set.
 */
export default function PendingRuns({ runs, onOpen, onDismiss }: Props) {
  if (runs.length === 0) return null

  return (
    <div className="pending-runs">
      <span className="pending-runs-label">
        <svg className="pending-runs-spinner" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
          <path d="M21 12a9 9 0 1 1-6.22-8.56" />
        </svg>
        {runs.length === 1 ? '1 chat working' : `${runs.length} chats working`}
      </span>
      {runs.map((r) => (
        <span key={r.id} className={`pending-run ${r.attention ? 'attention' : ''}`}>
          <button
            className="pending-run-open"
            onClick={() => onOpen(r.id)}
            title={[
              r.name,
              r.account ? `on ${r.account}` : null,
              r.attention ? 'waiting for your approval' : null
            ]
              .filter(Boolean)
              .join(' — ')}
          >
            {r.name}
            {r.account && <span className="pending-run-account">{r.account}</span>}
            {r.attention && <span className="pending-run-note">needs approval</span>}
          </button>
          <button
            className="pending-run-close"
            onClick={() => onDismiss(r.id)}
            title="Hide from this bar (the chat keeps running)"
            aria-label={`Hide ${r.name} from the pending bar`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
