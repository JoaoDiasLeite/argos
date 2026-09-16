import { useCallback, useRef } from 'react'
import { ApprovalRequest, ModelInfo, ProviderId, Session } from '../types'
import { provOf } from '../lib/account-scope'
import type { Props as ChatProps } from '../components/Chat'

/**
 * Everything a chat pane needs from the app, with nothing about *which* pane it is.
 *
 * The App used to derive the active chat's 34 `<Chat>` props inline, which only works
 * while there is exactly one chat on screen. This is the seam that makes N of them
 * possible: the App hands the same `api` object to every pane, and each pane resolves
 * its own props from it (see useSessionPane below).
 *
 * Every action takes the session id as its first argument — deliberately, so nothing
 * here can silently act on "the active chat" when the pane you clicked is a different
 * one. The three at the bottom have no session to act on at all.
 */
export interface SessionPaneApi {
  // ── Shared app state: the same for every pane ──────────────────────────────
  sessions: Session[]
  runningIds: Set<string>
  approvalQueue: ApprovalRequest[]
  models: ModelInfo[]
  defaultModel: string
  ready: boolean
  workMode: 'chat' | 'terminal'
  /** Prompts parked for a terminal to type once its CLI is up, by session id. */
  terminalPrompts: Record<string, string>
  /** "Land on this chat" stamps, by session id — a single counter would make every
   *  pane fight over the caret. Each value comes from one shared sequence, so it also
   *  says *when* that chat was landed on relative to the others. */
  newChatNonces: Record<string, number>
  compacting: boolean
  saveError: string
  /** Per-provider default accounts — a chat that names none inherits these. */
  defaultAccountId?: string
  codexDefaultAccountId?: string
  geminiDefaultAccountId?: string

  // ── Actions on one session ─────────────────────────────────────────────────
  sendMessage: (
    sid: string,
    text: string,
    images?: { mediaType: string; data: string }[],
    files?: { name: string; content: string }[],
    imageThumbnails?: string[]
  ) => void
  stopRun: (sid: string) => void
  retryTurn: (sid: string) => void
  editAndResend: (sid: string, messageId: string, newText: string) => void
  branchSession: (sid: string, messageId: string) => void
  patchSession: (sid: string, patch: Partial<Session>) => void
  setSessionModel: (sid: string, modelId: string) => void
  toggleAutoApprove: (sid: string) => void
  toggleLightMode: (sid: string) => void
  compactSession: (sid: string) => void
  closeChatTerminal: (sid: string) => void
  openClaudeMd: (sid: string) => void
  openCheckpoints: (sid: string) => void
  openGit: (sid: string) => void
  exportSession: (sid: string, format: 'md' | 'html') => void
  clearTerminalPrompt: (sid: string) => void

  // ── Actions with no session of their own ───────────────────────────────────
  /** Approvals are already addressed by their own id, not by the chat they came from. */
  onApproval: (approvalId: string, allow: boolean) => void
  createSession: () => void
  openSettings: () => void
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
    runningIds,
    approvalQueue,
    models,
    defaultModel,
    terminalPrompts,
    newChatNonces,
    defaultAccountId,
    codexDefaultAccountId,
    geminiDefaultAccountId
  } = api

  const session = sessions.find((s) => s.id === sessionId)

  // Chat takes a plain number and reacts to it *changing*, and this pane is not remounted
  // when it switches session (see ChatPane), so the value handed over must never go
  // backwards: switching back to a chat that was landed on earlier would otherwise read
  // as a fresh landing and steal the caret. Clamping to the highest stamp this pane has
  // seen keeps exactly the two cases that should greet you — this chat being landed on
  // again, and the pane following you to a chat just landed on — and nothing else.
  const highestNonce = useRef(0)
  const stamp = newChatNonces[sessionId] ?? 0
  if (stamp > highestNonce.current) highestNonce.current = stamp
  const newChatNonce = highestNonce.current
  const model = session?.model || defaultModel
  // Which CLI this chat's model belongs to — decides which binary the embedded terminal
  // launches, and therefore which account store the id below has to come from.
  const terminalProvider: ProviderId = provOf(models, model)
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

  const {
    sendMessage,
    stopRun,
    retryTurn,
    editAndResend,
    branchSession,
    patchSession,
    setSessionModel,
    toggleAutoApprove,
    toggleLightMode,
    compactSession,
    closeChatTerminal,
    openClaudeMd,
    openCheckpoints,
    openGit,
    exportSession,
    clearTerminalPrompt,
    createSession,
    openSettings
  } = api

  // Each bind closes over THIS pane's id. That is the whole point of the hook: with two
  // panes open, an action must reach the chat it was clicked in, never "the active one".
  const onSendMessage = useCallback<ChatProps['onSendMessage']>(
    (text, images, files, thumbs) => sendMessage(sessionId, text, images, files, thumbs),
    [sendMessage, sessionId]
  )
  const onStop = useCallback(() => stopRun(sessionId), [stopRun, sessionId])
  const onRetry = useCallback(() => retryTurn(sessionId), [retryTurn, sessionId])
  const onEditResend = useCallback(
    (messageId: string, newText: string) => editAndResend(sessionId, messageId, newText),
    [editAndResend, sessionId]
  )
  const onBranch = useCallback(
    (messageId: string) => branchSession(sessionId, messageId),
    [branchSession, sessionId]
  )
  // The riskiest bind in the file: this is how `terminalSessionId` reaches disk, and a
  // patch landing on the wrong chat archives a CLI conversation under someone else's
  // transcript, irreversibly. It must be the same id the Chat is rendering.
  const onPatchSession = useCallback(
    (patch: Partial<Session>) => patchSession(sessionId, patch),
    [patchSession, sessionId]
  )
  const onModelChange = useCallback(
    (modelId: string) => setSessionModel(sessionId, modelId),
    [setSessionModel, sessionId]
  )
  const onToggleAutoApprove = useCallback(
    () => toggleAutoApprove(sessionId),
    [toggleAutoApprove, sessionId]
  )
  const onToggleLightMode = useCallback(
    () => toggleLightMode(sessionId),
    [toggleLightMode, sessionId]
  )
  const onCompact = useCallback(() => compactSession(sessionId), [compactSession, sessionId])
  const onCloseTerminal = useCallback(
    () => closeChatTerminal(sessionId),
    [closeChatTerminal, sessionId]
  )
  const onOpenClaudeMd = useCallback(() => openClaudeMd(sessionId), [openClaudeMd, sessionId])
  const onOpenCheckpoints = useCallback(
    () => openCheckpoints(sessionId),
    [openCheckpoints, sessionId]
  )
  const onOpenGit = useCallback(() => openGit(sessionId), [openGit, sessionId])
  const onExportSession = useCallback(
    (format: 'md' | 'html') => exportSession(sessionId, format),
    [exportSession, sessionId]
  )
  // Cleared, not just consumed: a terminal that restarts must not re-run the task.
  const onInitialTerminalPromptSent = useCallback(
    () => clearTerminalPrompt(sessionId),
    [clearTerminalPrompt, sessionId]
  )

  return {
    session,
    streaming: session ? runningIds.has(session.id) : false,
    saveError: api.saveError,
    approval: approvalQueue.find((r) => r.appSessionId === session?.id),
    onApproval: api.onApproval,
    onSendMessage,
    onStop,
    onOpenSettings: openSettings,
    ready: api.ready,
    models,
    currentModel: model,
    onModelChange,
    terminalProvider,
    terminalAccountId,
    mode: api.workMode,
    initialTerminalPrompt: terminalPrompts[sessionId],
    onInitialTerminalPromptSent,
    newChatNonce,
    onOpenClaudeMd,
    autoApprove: session?.autoApprove ?? false,
    onToggleAutoApprove,
    lightMode: session?.lightMode ?? false,
    onToggleLightMode,
    onStartFresh: createSession,
    onCompact,
    compacting: api.compacting,
    onOpenCheckpoints,
    onOpenGit,
    onRetry,
    onEditResend,
    onBranch,
    onExportSession,
    onPatchSession,
    onCloseTerminal
  }
}
