// The nav rail's entries, by the id a user can hide them under (Settings → General).
//
// Shared because both ends need the list: main sanitizes `ui.hiddenNavItems` before it
// is stored (ui-prefs-pure.ts), and the renderer draws the rail and the toggles from it
// (NavRail.tsx). A single view is its own id; a group is its group key. Settings is not
// here on purpose: it is the way back to these toggles, so it can never be hidden.
export const NAV_ITEM_IDS = ['home', 'chat', 'projects', 'planner', 'companion', 'usage', 'servers'] as const

export type NavItemId = (typeof NAV_ITEM_IDS)[number]

export function isNavItemId(value: unknown): value is NavItemId {
  return typeof value === 'string' && (NAV_ITEM_IDS as readonly string[]).includes(value)
}

/** Known ids only, each once, in rail order. Anything else a config holds is dropped. */
export function sanitizeHiddenNavItems(value: unknown): NavItemId[] {
  if (!Array.isArray(value)) return []
  return NAV_ITEM_IDS.filter((id) => value.includes(id))
}
