import { useCallback, useRef } from 'react'
import { ChatPopoutSpec, ModelInfo, ProviderId, Session } from '../types'
import { chatTerminalId } from '../lib/terminal-id'
import { provOf, sessionProvider } from '../lib/account-scope'
import type { Props as ChatProps } from '../components/Chat'

/**
 * Everything a chat pane needs from the app, with nothing about *which* pane it is.
 *
 * The App hands the same `api` object to every pane, and each pane resolves its own
 * props from it (see useSessionPane below) — the seam that makes N panes possible.
 *
 * Every action takes the session id as its first argument — deliberately, so nothing
 * here can silently act on "the active chat" when the pane you clicked is a different
 * one.
 */
export interface SessionPaneApi {
  // ── Shared app state: the same for every pane ──────────────────────────────
  sessions: Session[]
  models: ModelInfo[]
  defaultModel: string
  /** Prompts parked for a terminal to type once its CLI is up, by session id. */
  terminalPrompts: Record<string, string>
  /** "Land on this chat" stamps, by session id — a single counter would make every
   *  pane react to every landing. Each value comes from one shared sequence, so it also
   *  says *when* that chat was landed on relative to the others. */
  newChatNonces: Record<string, number>
  /** Non-empty when the last autosave failed (see App's save interval). */
  saveError: string
  /** Per-provider default accounts — a chat that names none inherits these. */
  defaultAccountId?: string
  codexDefaultAccountId?: string
  geminiDefaultAccountId?: string

  // ── Actions on one session ─────────────────────────────────────────────────
  patchSession: (sid: string, patch: Partial<Session>) => void
  closeChatTerminal: (sid: string) => void
  clearTerminalPrompt: (sid: string) => void
  /** Open a chat in its own window, attached to the terminal its pane has now. */
  popOutChat: (spec: ChatPopoutSpec) => void
}

/**
 * The full `<Chat>` prop bag for one session, derived from the shared api.
 *
 * The return type is Chat's own Props, so the typecheck — not a reading of the JSX —
 * is what guarantees this stays complete as Chat's surface moves.
 */
export function useSessionPane(sessionId: string, api: SessionPaneApi): ChatProps {
  const {
    sessions,
    models,
    defaultModel,
    terminalPrompts,
    newChatNonces,
    defaultAccountId,
    codexDefaultAccountId,
    geminiDefaultAccountId,
    patchSession,
    closeChatTerminal,
    clearTerminalPrompt,
    popOutChat
  } = api

  const session = sessions.find((s) => s.id === sessionId)

  // Chat reacts to this number *changing*, and this pane is not remounted when it switches
  // session (see ChatPane), so the value handed over must never go backwards: switching
  // back to a chat that was landed on earlier would otherwise read as a fresh landing.
  // Clamping to the highest stamp this pane has seen keeps exactly the two cases that
  // count — this chat being landed on again, and the pane following you to a chat just
  // landed on — and nothing else.
  const highestNonce = useRef(0)
  const stamp = newChatNonces[sessionId] ?? 0
  if (stamp > highestNonce.current) highestNonce.current = stamp
  const newChatNonce = highestNonce.current
  // Which CLI this chat runs — decides which binary the embedded terminal launches, and
  // therefore which account store the id below has to come from.
  // No session yet: the CLI a new chat starts on, the default model's provider.
  const terminalProvider: ProviderId = session ? sessionProvider(session) : provOf(models, defaultModel)
  // Each provider keeps its own accounts, so the fallback has to be that provider's
  // default; a chat bound to a Codex account must not fall back to a Claude one.
  // Deliberately not acctOf() from account-scope: that one ends in a literal 'default'
  // account, and the terminal has to be able to be told "no account named at all".
  const terminalAccountId =
    terminalProvider === 'codex'
      ? (session?.codexAccountId ?? codexDefaultAccountId)
      : terminalProvider === 'gemini'
        ? (session?.geminiAccountId ?? geminiDefaultAccountId)
        : (session?.accountId ?? defaultAccountId)

  // Each bind closes over THIS pane's id. That is the whole point of the hook: with two
  // panes open, an action must reach the chat it was clicked in, never "the active one".
  // The riskiest bind in the file: this is how `terminalSessionId` reaches disk, and a
  // patch landing on the wrong chat archives a CLI conversation under someone else's
  // transcript, irreversibly. It must be the same id the Chat is rendering.
  const onPatchSession = useCallback(
    (patch: Partial<Session>) => patchSession(sessionId, patch),
    [patchSession, sessionId]
  )
  const onCloseTerminal = useCallback(
    () => closeChatTerminal(sessionId),
    [closeChatTerminal, sessionId]
  )
  // Cleared, not just consumed: a terminal that restarts must not re-run the task.
  const onInitialTerminalPromptSent = useCallback(
    () => clearTerminalPrompt(sessionId),
    [clearTerminalPrompt, sessionId]
  )

  // The window gets exactly what this pane's ChatTerminal is given, so if the pty has died
  // meanwhile it starts the same CLI, under the same account, in the same place.
  const onPopOut = session
    ? () =>
        popOutChat({
          sessionId,
          name: session.name,
          terminalId: chatTerminalId(sessionId),
          provider: terminalProvider,
          cwd: session.projectPath,
          accountId: terminalAccountId,
          wslDistro: session.wslDistro,
          remoteHostId: session.remoteHostId,
          resumeSessionId: session.claudeSessionId,
          pinSessionId: session.terminalSessionId
        })
    : undefined

  return {
    session,
    onPopOut,
    saveError: api.saveError,
    terminalProvider,
    terminalAccountId,
    initialTerminalPrompt: terminalPrompts[sessionId],
    onInitialTerminalPromptSent,
    newChatNonce,
    onPatchSession,
    onCloseTerminal
  }
}
