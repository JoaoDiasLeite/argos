// Pure account-scoping helpers, extracted from Sidebar.tsx so they can be unit-tested
// without mounting React. These decide which provider/account a chat belongs to, and
// which chats are visible for the currently-selected provider + account. Keep this file
// side-effect-free (no React, no window.electronAPI) — Sidebar.tsx and App.tsx are the
// only callers that know about state.
import { ModelInfo, ProviderId, Session } from '../types'

// Resolve a model id to the provider that serves it (falls back to 'claude' for unknown
// / legacy model ids that predate the model catalog).
export function provOf(models: ModelInfo[], modelId?: string): ProviderId {
  return models.find((m) => (modelId ?? '').startsWith(m.id))?.provider ?? 'claude'
}

// The app-wide default account per provider, as tracked in App.tsx state. Passed in
// (rather than imported) so this module has no dependency on App's state shape.
export interface AccountDefaults {
  defaultAccountId?: string
  codexDefaultAccountId?: string
  geminiDefaultAccountId?: string
}

// Which account a chat is filed under. Fallbacks mirror how an unbound chat actually
// RUNS (see App.tsx's buildAgentPayload), so a chat is never filed under an account it
// wouldn't run on. A legacy chat with no accountId/codexAccountId/geminiAccountId runs
// on that provider's current default account — Claude, Codex and Gemini all resolve the
// same way now. (Previously Codex fell through to the literal 'default' account instead
// of codexDefaultAccountId, which could file/scope an unbound Codex chat under the wrong
// account once a non-default account became the Codex default — see NEXT_FIXES #2.)
export function acctOf(s: Session, models: ModelInfo[], defaults: AccountDefaults): string {
  const p = provOf(models, s.model)
  return p === 'codex'
    ? (s.codexAccountId ?? defaults.codexDefaultAccountId ?? 'default')
    : p === 'gemini'
      ? (s.geminiAccountId ?? defaults.geminiDefaultAccountId ?? 'default')
      : (s.accountId ?? defaults.defaultAccountId ?? 'default')
}

/**
 * Where a chat actually runs, when that is somewhere other than "this machine, under a
 * managed account": a WSL distro, or a remote SSH host.
 *
 * This exists because `acctOf` cannot tell the truth about those chats. Argos's account
 * ids name logins IT manages (see accounts.ts); a chat inside a distro or on a box over
 * SSH runs against whatever CLI login lives THERE — Claude Code files those under their
 * own source ids, 'wsl:<distro>' and friends (see main/claude-data.ts). So a WSL chat
 * carries an accountId only because every session is created with one, and `acctOf`
 * dutifully resolves it (or the default) to an account the run never touched. Anywhere a
 * chat's origin is shown to the user, ask this first and only fall back to the account.
 *
 * `key` is for comparing origins, `label` for showing one, and `short` for showing one
 * where the row is already fighting for width — a chat-list row, where the name is what
 * matters and a full "WSL · Ubuntu-DevOps" pushes it down to an ellipsis. Null means an
 * ordinary local chat, where the managed account IS the answer.
 */
export function originOf(s: Session): { key: string; label: string; short: string } | null {
  if (s.wslDistro) {
    return {
      key: `wsl:${s.wslDistro}`,
      label: s.remoteHostName || `WSL · ${s.wslDistro}`,
      short: s.wslDistro
    }
  }
  if (s.remoteHostId) {
    const name = s.remoteHostName || 'Remote'
    return { key: `ssh:${s.remoteHostId}`, label: name, short: name }
  }
  return null
}

// The account currently IN EFFECT for `provider`: the active chat's account when
// `provider` is the one currently selected, falling back to that provider's default.
// Opening a chat bound to another account (e.g. from Projects) therefore moves the
// row, its usage badge and the session list onto that account instead of silently
// disagreeing with the chat on screen.
export function idFor(
  provider: ProviderId,
  selectedProvider: ProviderId,
  selectedAccountId: string | undefined,
  fallback?: string
): string {
  return (provider === selectedProvider ? selectedAccountId : undefined) ?? fallback ?? 'default'
}

// Blank "New chat" drafts (no messages yet, and never used via the embedded terminal
// either) stay out of the list — the Sessions section only appears once at least one
// chat has real content. Chats are also scoped to the
// selected provider + account: a chat is permanently bound to the provider/account that
// created it, so switching either swaps the visible history. Older chats without an
// accountId fall under that provider's machine-default account ('default'), same as
// `acctOf` resolves. Everything (across accounts) remains reachable via
// "Explore all chats" → Projects.
//
// A chat with an ORIGIN (see originOf) is filed the same way. It runs against a CLI login
// inside a distro or on a remote host rather than the account it carries, but that account
// is still the one it was created under, and a chat started while working on one account
// showing up in another's list reads as a leak between them. Its row says where it runs.
export function visibleSessions(
  sessions: Session[],
  models: ModelInfo[],
  selectedProvider: ProviderId,
  currentAccountId: string,
  defaults: AccountDefaults
): Session[] {
  return sessions.filter(
    (s) =>
      (s.messages.length > 0 || s.hasTerminalActivity) &&
      provOf(models, s.model) === selectedProvider &&
      acctOf(s, models, defaults) === currentAccountId
  )
}

/**
 * A chat nothing has happened in yet — the only kind an account switch may rebind.
 *
 * Zero messages is not enough on its own: a chat driven from the embedded terminal has
 * none until its transcript is synced, which may not be until the run is over. Treating
 * that as a blank draft moved a chat onto the account just picked while it was still
 * running there — relaunching its terminal under a login its conversation doesn't exist
 * on, and filing it under an account whose list you'd already left.
 */
export function isUnstarted(s: Session): boolean {
  return s.messages.length === 0 && !s.hasTerminalActivity
}

/** The provider and account a chat puts the sidebar on while it is the active chat. */
export function scopeOf(s: Session, models: ModelInfo[], defaults: AccountDefaults): string {
  return `${provOf(models, s.model)}:${acctOf(s, models, defaults)}`
}

/**
 * The chat to land on after the active one is closed, or undefined for the welcome pane.
 *
 * Only a chat that keeps the sidebar where it is. The active chat decides which account
 * the sidebar shows, so falling through to whatever chat happens to be first moved you
 * onto another account just for closing one — and switching accounts is always a
 * deliberate act, never a side effect.
 */
export function nextChatAfterClose(
  closed: Session,
  remaining: Session[],
  models: ModelInfo[],
  defaults: AccountDefaults
): Session | undefined {
  const scope = scopeOf(closed, models, defaults)
  return remaining.find(
    (s) => (s.messages.length > 0 || s.hasTerminalActivity) && scopeOf(s, models, defaults) === scope
  )
}
