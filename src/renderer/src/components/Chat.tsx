import { useEffect, useState, lazy, Suspense } from 'react'
import { Session, ProviderId } from '../types'
import ChatConfigBar from './ChatConfigBar'
import { chatTerminalId } from '../lib/terminal-id'
import './Chat.css'

// ChatTerminal pulls in @xterm/xterm + its addons (~300 kB), and nothing on screen needs
// it until a chat is actually opened — so it's loaded lazily instead of bundled into the
// initial chunk.
const ChatTerminal = lazy(() => import('./ChatTerminal'))

export interface Props {
  session?: Session
  /** Non-empty when the last autosave of this chat's record failed. */
  saveError: string
  /** The chat's provider — forwarded to ChatTerminal to launch the right CLI. */
  terminalProvider: ProviderId
  /** The account (for terminalProvider) this chat is bound to — forwarded to ChatTerminal. */
  terminalAccountId?: string
  /** A prompt to type into the CLI once it is up — Home's start box, the quick launcher
   *  and the planner hand one over so "start this here" lands in the terminal. */
  initialTerminalPrompt?: string
  /** Fired once that prompt has been sent, so App can forget it (it must not be
   *  replayed if the terminal restarts). */
  onInitialTerminalPromptSent?: () => void
  /** Bumped by App whenever it deliberately lands you on a chat (New terminal, switching
   *  account) — part of the key that decides whether the setup pane is shown. */
  newChatNonce: number
  /** Patch this chat (folder / environment) from the setup pane, and record the
   *  terminal's activity. */
  onPatchSession: (patch: Partial<Session>) => void
  /** Leave this terminal — the pty is torn down and the view falls back to the welcome
   *  pane. The chat itself stays in the sidebar. */
  onCloseTerminal: () => void
  /** True when a split-view pane header is already drawing this chat's name (see
   *  `PaneGrid`'s `pane-head`) — so this component must not draw it a second time. The
   *  rest of the title block (remote host / resumed marker) still renders, since the
   *  pane header has no room for it. */
  titleInHeader?: boolean
}

/**
 * A chat, which is a terminal: the CLI running in an embedded xterm, plus the one
 * pre-launch pane that decides where it runs.
 */
export default function Chat({
  session,
  saveError,
  terminalProvider,
  terminalAccountId,
  initialTerminalPrompt,
  onInitialTerminalPromptSent,
  newChatNonce,
  onPatchSession,
  onCloseTerminal,
  titleInHeader = false
}: Props) {
  // The pty is created on the same render that mounts ChatTerminal, so where it runs has
  // to be settled BEFORE that — a CLI already launched in the wrong folder has no undo. A
  // terminal that arrives with no folder at all (New terminal from the welcome pane, with
  // no chat open to inherit one from) therefore opens on a setup pane: pick the
  // environment and folder, then Start. One that already knows where it runs (a project
  // group's "+", Open with Argos, Home's start box, a WSL/SSH environment, or any chat
  // that has already had a terminal in it) skips it — that choice was made elsewhere.
  //
  // Decided once per chat, the first time it is rendered, and then left alone: the setup
  // pane's own config bar patches the session as you use it, so re-deriving this on every
  // render would launch the pty mid-edit — choosing "WSL" clears projectPath and picking
  // the distro would read as "configured" before a folder was ever named.
  // The nonce is part of the key, not just the id: pressing New terminal on a chat that is
  // already the open draft is the one way this has to be asked again, and the answer would
  // otherwise be frozen from the first time the chat was seen. It cannot be re-derived from
  // the session alone — after Start with no folder chosen, the session still knows nothing
  // about where it runs, and that would snap straight back to the setup pane.
  const [setup, setSetup] = useState<{ id: string; nonce: number; pending: boolean } | null>(null)
  if (session && (setup?.id !== session.id || setup.nonce !== newChatNonce)) {
    // Adjusting state during the render (rather than in an effect) is deliberate: an effect
    // runs after the commit that already mounted ChatTerminal and spawned its pty.
    const knowsWhereItRuns =
      !!session.projectPath || !!session.remoteHostId || !!session.wslDistro || !!session.hasTerminalActivity
    setSetup({ id: session.id, nonce: newChatNonce, pending: !knowsWhereItRuns })
  }
  const needsTerminalSetup = !!session && setup?.id === session.id && setup.pending
  const termOpen = !!session && !needsTerminalSetup
  // Backfill for chats that predate newSession handing every chat an id of its own.
  // Naming the session before the CLI does is what makes the title, the transcript and
  // the running dot findable at all — left to the CLI, that id is invented inside the pty
  // and never told to anyone. This cannot be the only place it happens, though: the
  // terminal is created on the same render that mounts it, so an id patched in from here
  // lands after the CLI has already been launched without one. New chats arrive with
  // theirs already set (see newSession) and never reach this.
  const chatId = session?.id
  const hasClaudeId = !!session?.claudeSessionId
  const hasTerminalId = !!session?.terminalSessionId
  useEffect(() => {
    if (!termOpen || !chatId || hasClaudeId || hasTerminalId) return
    onPatchSession({ terminalSessionId: crypto.randomUUID() })
  }, [termOpen, chatId, hasClaudeId, hasTerminalId, onPatchSession])
  // The save-error banner has no real "resolved" signal from the caller (saveError just
  // clears itself once a save succeeds), so "dismiss" only has to mean "stop showing me
  // *this* failure" — tracked by comparing against the last message the user waved away.
  const [dismissedSaveError, setDismissedSaveError] = useState('')

  // Title block for the setup pane: the chat's name plus one quiet meta line. Only for a
  // chat that already has a name of its own — a fresh one is still the placeholder "New
  // chat", and printing that above "Start a terminal" reads as two headings. The name is
  // skipped when a split-view pane header is already showing it.
  const hasTitleMeta = !!(session?.remoteHostName || session?.claudeSessionId)
  const showTitleName = !titleInHeader && !!session?.name && session.name !== 'New chat'
  const titleBlock = session && (showTitleName || hasTitleMeta) && (
    <div className="chat-title-block">
      {showTitleName && <div className="chat-title-name">{session.name}</div>}
      {hasTitleMeta && (
        <div className="chat-title-meta">
          {session.remoteHostName && (
            <span title="Running on remote host over SSH">⇄ {session.remoteHostName}</span>
          )}
          {session.claudeSessionId && <span title="Resumed Claude Code session">resumed</span>}
        </div>
      )}
    </div>
  )

  return (
    <div className="chat">
      {saveError && dismissedSaveError !== saveError && (
        <div className="save-error-banner" role="alert">
          <span className="save-error-text">
            This chat couldn&rsquo;t be saved to disk — its name, folder and link to the CLI
            conversation may be lost if the app closes. {/* The caller hands us a
            stringified Error; its "Error: " prefix is noise in a sentence the user reads. */}
            ({saveError.replace(/^Error:\s*/, '')})
          </span>
          <button
            className="save-error-dismiss"
            onClick={() => setDismissedSaveError(saveError)}
            title="Dismiss"
            aria-label="Dismiss this warning"
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}

      {session && needsTerminalSetup && (
        <div className="terminal-setup">
          {titleBlock}
          <h2>Start a terminal</h2>
          <p>
            Pick where it runs — the CLI starts there and can't be moved afterwards.
          </p>
          <ChatConfigBar session={session} onPatch={onPatchSession} />
          <button
            className="btn-primary terminal-setup-start"
            onClick={() => setSetup({ id: session.id, nonce: newChatNonce, pending: false })}
          >
            Start terminal
          </button>
          {!session.projectPath && !session.remoteHostId && (
            <span className="terminal-setup-hint">No folder chosen — it will start in your home folder.</span>
          )}
        </div>
      )}

      {session && termOpen && (
        <Suspense fallback={null}>
          <ChatTerminal
            key={session.id}
            terminalId={chatTerminalId(session.id)}
            cwd={session.projectPath}
            accountId={terminalAccountId}
            provider={terminalProvider}
            wslDistro={session.wslDistro}
            remoteHostId={session.remoteHostId}
            /* Two ids, two intentions: resume the conversation this chat already has,
               or create one under the id it reserved before ever starting. */
            resumeSessionId={session.claudeSessionId}
            pinSessionId={session.terminalSessionId}
            initialPrompt={initialTerminalPrompt}
            onInitialPromptSent={onInitialTerminalPromptSent}
            onClose={onCloseTerminal}
            onActive={() => {
              // The stamp is the lower bound on which Codex conversation can be this
              // chat's, so it is written once and never moved: a terminal reopened later
              // must not let the chat reach back and claim something older.
              if (!session.hasTerminalActivity || !session.terminalStartedAt) {
                onPatchSession({
                  hasTerminalActivity: true,
                  ...(session.terminalStartedAt ? {} : { terminalStartedAt: Date.now() })
                })
              }
            }}
          />
        </Suspense>
      )}
    </div>
  )
}
