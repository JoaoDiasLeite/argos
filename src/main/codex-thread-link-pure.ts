/**
 * Matching a Codex terminal chat to the Codex conversation it started.
 *
 * A Claude chat never needs this: it picks a session id, hands it to the CLI with
 * `--session-id`, and the transcript it later reads is the one it named. The Codex CLI
 * has no such flag, so the conversation gets an id Argos was never told, and the chat is
 * left holding nothing — no title, and no way to find the transcript that would give it
 * one. That is why a Codex chat driven from the terminal never renamed itself.
 *
 * What is left is descent in time rather than by name: the thread a chat started is the
 * first one recorded in that chat's folder after that chat's terminal came up. It is a
 * claim, not a proof, so it is made as narrowly as the facts allow — same folder, not
 * before the terminal, not already spoken for, and oldest-first so that two chats opened
 * in one folder take their own threads rather than both taking the newer one.
 *
 * Refusing to guess is a real outcome here. A chat with no thread keeps the name it has,
 * which is the same state it was already in; a chat pointed at someone else's
 * conversation would take that conversation's title and show its messages.
 */

/** The half of a Codex thread that matters for matching. Mirrors CodexThread in
 *  codex-threads.ts, kept structural so this module stays free of the spawn path. */
export interface LinkableThread {
  id: string
  cwd: string
  name?: string
  preview: string
  /** Unix SECONDS, as `thread/list` reports them. */
  createdAt: number
}

/** The half of a chat that matters for matching. */
export interface LinkableChat {
  id: string
  /** The folder the chat's terminal was opened in. */
  cwd: string
  /** When that terminal came up, in MILLISECONDS. */
  startedAt: number
}

/**
 * A thread recorded this long before a chat's terminal came up is still allowed to be
 * that chat's.
 *
 * `createdAt` arrives in whole seconds, so a thread created in the same second the
 * terminal started can report a timestamp a fraction earlier than the chat's own
 * millisecond one. The window is small on purpose: widening it to be safe is how a chat
 * ends up claiming the thread belonging to whatever ran in that folder just before it.
 */
export const LINK_SLACK_MS = 2_000

/** Trailing separators and case on Windows aside, two spellings of one folder are one
 *  folder. Codex records the cwd its own process saw, which need not be spelled the way
 *  Argos stored it. */
function sameFolder(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * Work out which thread belongs to each chat.
 *
 * Returns only the chats it could place, as `{ [chatId]: threadId }`. Chats are taken
 * oldest terminal first so that each one claims the earliest thread still going: with
 * two chats open in one folder, the first chat takes the first thread and the second is
 * left to take the second, which handing them out newest-first would get backwards.
 *
 * `claimed` is the set of thread ids other chats already hold — pass it, or a chat that
 * reopens its terminal will claim a thread another chat is already showing.
 */
export function pickThreadsForChats(
  chats: LinkableChat[],
  threads: LinkableThread[],
  claimed: ReadonlySet<string> = new Set()
): Record<string, string> {
  const taken = new Set(claimed)
  const out: Record<string, string> = {}

  const byStart = [...chats].sort((a, b) => a.startedAt - b.startedAt)
  const oldestFirst = [...threads].sort((a, b) => a.createdAt - b.createdAt)

  for (const chat of byStart) {
    const hit = oldestFirst.find(
      (t) =>
        !taken.has(t.id) &&
        sameFolder(t.cwd, chat.cwd) &&
        t.createdAt * 1000 >= chat.startedAt - LINK_SLACK_MS
    )
    if (!hit) continue
    taken.add(hit.id)
    out[chat.id] = hit.id
  }
  return out
}

/** How long a title taken from a thread's first message is allowed to be — the same cut
 *  a chat's own composer makes when it names a conversation from its opening turn. */
const PREVIEW_TITLE_MAX = 40

/**
 * What to call a chat that has been linked to this thread, or `null` to leave its name
 * alone.
 *
 * Codex's own title wins when it has settled on one. Before that there is the first user
 * message, which is what the chat would have been called had the turn gone through
 * Argos's composer — so a linked chat reads the same either way. A thread with neither
 * yields nothing rather than a placeholder: "New chat" is a better name than a bad one.
 */
export function titleForThread(thread: LinkableThread): string | null {
  if (thread.name?.trim()) return thread.name.trim()
  const firstLine = thread.preview.trim().split('\n')[0]?.trim()
  if (!firstLine) return null
  return firstLine.slice(0, PREVIEW_TITLE_MAX)
}
