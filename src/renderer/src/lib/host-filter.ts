/** What the Servers list needs from a saved SSH host to order and filter it. */
export interface FilterableHost {
  name: string
  host: string
  username: string
  favorite?: boolean
  tags?: string[]
}

/** Favourites first; inside each group the incoming order is kept. */
export function favoritesFirst<T extends { favorite?: boolean }>(hosts: T[]): T[] {
  return [...hosts.filter((h) => h.favorite), ...hosts.filter((h) => !h.favorite)]
}

/** Every tag in use, one spelling per case-insensitive tag (the first seen), sorted. */
export function allHostTags(hosts: { tags?: string[] }[]): string[] {
  const seen = new Map<string, string>()
  for (const h of hosts) {
    for (const tag of h.tags ?? []) {
      const key = tag.toLowerCase()
      if (!seen.has(key)) seen.set(key, tag)
    }
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/**
 * The hosts that match the search text (name, address, user or any tag, case-insensitive)
 * and carry every selected tag, favourites first.
 *
 * With `extras` false (the experimental features off) tags and favourites play no part: the
 * search reads name, address and user only, and the saved order is kept, as before 3.9.0.
 */
export function filterHosts<T extends FilterableHost>(hosts: T[], query: string, selectedTags: string[], extras = true): T[] {
  const q = query.trim().toLowerCase()
  const wanted = extras ? selectedTags.map((t) => t.toLowerCase()) : []
  const matches = (h: T): boolean => {
    const tags = extras ? (h.tags ?? []).map((t) => t.toLowerCase()) : []
    if (!wanted.every((t) => tags.includes(t))) return false
    return (
      !q ||
      h.name.toLowerCase().includes(q) ||
      h.host.toLowerCase().includes(q) ||
      h.username.toLowerCase().includes(q) ||
      tags.some((t) => t.includes(q))
    )
  }
  const found = hosts.filter(matches)
  return extras ? favoritesFirst(found) : found
}
