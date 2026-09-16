import Chat from './Chat'
import { SessionPaneApi, useSessionPane } from '../hooks/useSessionPane'

/**
 * One chat pane, bound to one session.
 *
 * It exists because useSessionPane cannot be called in a loop from the App — a hook per
 * pane needs a component per pane. Everything else lives in the hook; this is just the
 * place the hook is allowed to run.
 */
export default function ChatPane({
  sessionId,
  api
}: {
  sessionId: string
  api: SessionPaneApi
}) {
  const props = useSessionPane(sessionId, api)
  // A pane pointed at a session that no longer exists (closed, or not loaded yet) renders
  // nothing rather than Chat's empty state — the empty state belongs to "no chat open".
  if (!props.session) return null
  /* Deliberately NOT keyed by sessionId: Chat holds the unsent composer text in state, and
     remounting per chat would throw away a draft every time you switch. */
  return <Chat {...props} />
}
