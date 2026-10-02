/**
 * Recently opened runbook folders (absolute paths, most recent first), kept in
 * localStorage. Servers → Ops writes them; the Remote view's Ops button and App's
 * host-to-runbook lookup read them.
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
