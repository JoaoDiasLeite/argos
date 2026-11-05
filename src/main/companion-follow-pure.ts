/**
 * "Follow me" (docs/COMPANION_PLAN.md §13.1, batch O2): with Argos on screen all day,
 * when the cursor has been on another display for a while he goes there. The clock is
 * pure, so it can be tested without Electron; companion-window.ts reads the cursor every
 * FOLLOW_POLL_MS and acts on shouldFollow().
 */

/** How often the cursor's display is checked. */
export const FOLLOW_POLL_MS = 2000

/** The cursor on another display for this long, and he sets off. */
export const FOLLOW_AFTER_MS = 20_000

/** The display the cursor has been on, away from the pet, and since when. */
export interface FollowWatch {
  displayId: number
  since: number
}

/**
 * The watch after one look at the cursor: nothing while it is on the pet's display, the
 * same watch while it stays on the one it moved to, a fresh one when it moves on.
 */
export function followUpdate(
  watch: FollowWatch | null,
  cursorDisplayId: number,
  petDisplayId: number,
  now: number
): FollowWatch | null {
  if (cursorDisplayId === petDisplayId) return null
  if (watch && watch.displayId === cursorDisplayId) return watch
  return { displayId: cursorDisplayId, since: now }
}

/** Whether the cursor has been away long enough. */
export function shouldFollow(watch: FollowWatch | null, now: number): boolean {
  return !!watch && now - watch.since >= FOLLOW_AFTER_MS
}
