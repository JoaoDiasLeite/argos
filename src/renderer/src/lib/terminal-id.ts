/**
 * The id of the pty a chat's embedded terminal runs in.
 *
 * One line, its own file, because two places need to agree on it and they are far
 * apart: the chat pane, which creates the terminal, and the adoption round in App,
 * which asks the main process what is running inside it. A second spelling of this
 * prefix would not fail loudly — it would just quietly stop adopting anything.
 */
export function chatTerminalId(sessionId: string): string {
  return `chatterm_${sessionId}`
}

const CHAT_TERMINAL_PREFIX = 'chatterm_'

/** The chat a terminal id belongs to, or null for a pty that is not a chat's — the
 *  standalone terminal grid keeps its own, and they arrive on the same events. */
export function sessionIdFromTerminalId(terminalId: string): string | null {
  if (!terminalId.startsWith(CHAT_TERMINAL_PREFIX)) return null
  return terminalId.slice(CHAT_TERMINAL_PREFIX.length) || null
}
