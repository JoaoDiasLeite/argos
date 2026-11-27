// The nav rail's entries, by the id a user can hide or reorder them under
// (Settings → General).
//
// Shared because both ends need the list: main sanitizes `ui.hiddenNavItems` and
// `ui.navOrder` before they are stored (ui-prefs-pure.ts), and the renderer draws the rail
// and the chips from it (NavRail.tsx). A single view is its own id; a group is its group
// key. Settings is not here on purpose: it is the way back to these controls, so it can
// never be hidden or moved.
export const NAV_ITEM_IDS = ['home', 'chat', 'projects', 'planner', 'companion', 'usage', 'servers'] as const

export type NavItemId = (typeof NAV_ITEM_IDS)[number]

/** Where the app opens: Home, Chat, or the view it was on when it last closed. */
export const START_VIEWS = ['home', 'chat', 'last'] as const
export type StartView = (typeof START_VIEWS)[number]

export function isStartView(value: unknown): value is StartView {
  return typeof value === 'string' && (START_VIEWS as readonly string[]).includes(value)
}

export function isNavItemId(value: unknown): value is NavItemId {
  return typeof value === 'string' && (NAV_ITEM_IDS as readonly string[]).includes(value)
}

/** Known ids only, each once, in rail order. Anything else a config holds is dropped. */
export function sanitizeHiddenNavItems(value: unknown): NavItemId[] {
  if (!Array.isArray(value)) return []
  return NAV_ITEM_IDS.filter((id) => value.includes(id))
}

/**
 * The full rail order a stored value stands for: its known ids, each once, in the order
 * given, followed by every id it does not name in the default order. So a list written
 * before an entry existed still shows that entry (at the end), and an id no build has
 * is ignored rather than leaving a hole.
 */
export function orderNavItems(value: unknown): NavItemId[] {
  const seen: NavItemId[] = []
  if (Array.isArray(value)) {
    for (const id of value) if (isNavItemId(id) && !seen.includes(id)) seen.push(id)
  }
  return [...seen, ...NAV_ITEM_IDS.filter((id) => !seen.includes(id))]
}

/** `order` with `id` moved to position `to` (clamped). Returns a new array. */
export function moveNavItem(order: readonly NavItemId[], id: NavItemId, to: number): NavItemId[] {
  const from = order.indexOf(id)
  if (from < 0) return [...order]
  const next = order.filter((x) => x !== id)
  next.splice(Math.max(0, Math.min(next.length, to)), 0, id)
  return next
}

/** Whether an order is just the default one, in which case nothing needs storing. */
export function isDefaultNavOrder(order: readonly NavItemId[]): boolean {
  return order.length === NAV_ITEM_IDS.length && order.every((id, i) => id === NAV_ITEM_IDS[i])
}
