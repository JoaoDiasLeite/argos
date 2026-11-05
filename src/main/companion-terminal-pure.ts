/**
 * Argos saying that a chat terminal finished, or is waiting on you (docs/COMPANION_PLAN.md
 * §7, item 3). Two sources tell main about the same chat: an embedded terminal going from
 * busy to idle (or its CLI raising OSC 9), and Claude Code's Notification hook, which
 * fires for embedded chats too, a minute after the turn ended or when it asks for a
 * permission. These rules keep the pet to one word per turn: the first one he says, and
 * a later one only when it is more urgent ("needs you" after "finished").
 */
import type { CompanionTerminalAlert } from './companion-types'

/** A terminal bubble nobody answered goes away on its own after this long. */
export const TERMINAL_ALERT_MS = 30_000

/** Queued behind a reminder for longer than this, it is old news and is dropped. */
export const TERMINAL_STALE_MS = 10 * 60_000

type Kind = CompanionTerminalAlert['kind']

/**
 * Whether to say `kind` about a chat that was already told `told` this turn (undefined
 * when it was not). Never the same thing twice, and nothing after "waiting".
 */
export function shouldTell(told: Kind | undefined, kind: Kind): boolean {
  if (told === undefined) return true
  return told === 'finished' && kind === 'waiting'
}

/** The key an embedded chat terminal's alerts share, whichever source they came from. */
export function terminalKey(terminalId: string): string {
  return `term:${terminalId}`
}

/**
 * The key for a hook notification: the embedded terminal running that Claude session if
 * there is one (so both sources land on one key), else the session itself.
 */
export function hookKey(claudeSessionId: string | null, terminals: ReadonlyMap<string, string>, title: string): string {
  if (claudeSessionId) {
    for (const [terminalId, sid] of terminals) {
      if (sid === claudeSessionId) return terminalKey(terminalId)
    }
    return `claude:${claudeSessionId}`
  }
  return `hook:${title}`
}

/** "chatterm_<id>" → the chat's session id; null for any other pty (grid, ops, remote). */
export function chatSessionId(terminalId: string): string | null {
  const prefix = 'chatterm_'
  return terminalId.startsWith(prefix) && terminalId.length > prefix.length ? terminalId.slice(prefix.length) : null
}
