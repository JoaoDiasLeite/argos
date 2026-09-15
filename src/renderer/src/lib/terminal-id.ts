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
