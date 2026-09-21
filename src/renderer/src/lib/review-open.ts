/**
 * Which chats have the Review panel open, persisted across restarts.
 *
 * A working preference rather than a mode — the terminal is decided for the whole app,
 * this is decided per chat and remembered for that chat. Only the open ones are stored:
 * keeping the false entries would grow the record by a key for every chat ever opened,
 * and it would never shrink.
 */

const REVIEW_OPEN_KEY = 'argos.reviewOpenById'

export type ReviewOpenMap = Record<string, boolean>

/** Storage can be unavailable or hold something else entirely; a panel preference is
 *  never worth failing a render over, so anything unreadable is treated as "none open". */
export function readReviewOpen(): ReviewOpenMap {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(REVIEW_OPEN_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as ReviewOpenMap
  } catch {
    return {}
  }
}

export function writeReviewOpen(map: ReviewOpenMap): void {
  try {
    localStorage.setItem(REVIEW_OPEN_KEY, JSON.stringify(map))
  } catch {
    // Quota or a locked-down storage: the panel just forgets, which is survivable.
  }
}

/** The map with `id` flipped — deleting rather than storing false, per the note above.
 *  Pure, so the caller decides when it reaches state and disk. */
export function toggleReviewOpen(map: ReviewOpenMap, id: string): ReviewOpenMap {
  const next = { ...map }
  if (next[id]) delete next[id]
  else next[id] = true
  return next
}
