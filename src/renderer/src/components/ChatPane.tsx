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
  api,
  titleInHeader
}: {
  sessionId: string
  api: SessionPaneApi
  /** Forwarded to `Chat` as-is — see its doc comment. Defaults to false there, so a plain
   *  `<ChatPane sessionId api />` (single-pane case) draws the name itself. */
  titleInHeader?: boolean
}) {
  const props = useSessionPane(sessionId, api)
  // A pane pointed at a session that no longer exists (closed, or not loaded yet) renders
  // nothing rather than Chat's empty state — the empty state belongs to "no chat open".
  if (!props.session) return null
  /* Not keyed by sessionId, and it does not need to be: Chat tracks its setup-pane decision
     per chat id itself, and keys its ChatTerminal by session id, so switching chats already
     gives each one its own terminal. */
  return <Chat {...props} titleInHeader={titleInHeader} />
}
