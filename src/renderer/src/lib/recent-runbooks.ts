/**
 * Recently opened runbook folders (absolute paths, most recent first), kept in
 * localStorage. The intervention start screen (Servers → Ops) writes them; the Remote
 * view's Ops button reads them.
 */
export const RECENT_RUNBOOKS_KEY = 'ops.recentRunbooks'
export const RECENT_RUNBOOKS_MAX = 8

export function readRecentRunbooks(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_RUNBOOKS_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list)
      ? list.filter((p): p is string => typeof p === 'string' && p !== '').slice(0, RECENT_RUNBOOKS_MAX)
      : []
  } catch {
    return []
  }
}

/** Puts `dir` at the head of the recents (de-duplicated, capped) and returns the new list. */
export function pushRecentRunbook(dir: string): string[] {
  const next = [dir, ...readRecentRunbooks().filter((p) => p !== dir)].slice(0, RECENT_RUNBOOKS_MAX)
  try {
    localStorage.setItem(RECENT_RUNBOOKS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable: the list just isn't remembered */
  }
  return next
}

/** Drops `dir` from the recents and returns the new list. */
export function forgetRecentRunbook(dir: string): string[] {
  const next = readRecentRunbooks().filter((p) => p !== dir)
  try {
    localStorage.setItem(RECENT_RUNBOOKS_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable */
  }
  return next
}
