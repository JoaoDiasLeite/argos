/**
 * The Servers list, grouped: one section per server group (by name), then the hosts in no
 * group. Kept free of React and storage so it can be tested; RemoteView persists the folded
 * groups with the two helpers at the end.
 */

export interface GroupLike {
  id: string
  name: string
}

export interface HostSection<H, G extends GroupLike> {
  /** null: the hosts in no group, or in a group that no longer exists. */
  group: G | null
  hosts: H[]
}

/**
 * `hosts` (already filtered and ordered, favourites first) split by group, keeping their
 * order inside each one, so favourites still float first within a group. Groups come sorted
 * by name, the ungrouped hosts last. While a filter is on, a group with no matching host is
 * left out; with no filter an empty group still shows, so it can be found and managed. The
 * ungrouped section only appears when it has hosts.
 */
export function groupHosts<H extends { groupId?: string }, G extends GroupLike>(
  hosts: H[],
  groups: G[],
  filtering: boolean,
  locale?: string
): HostSection<H, G>[] {
  const known = new Set(groups.map((g) => g.id))
  const byGroup = new Map<string, H[]>()
  const loose: H[] = []
  for (const h of hosts) {
    if (h.groupId && known.has(h.groupId)) {
      const list = byGroup.get(h.groupId)
      if (list) list.push(h)
      else byGroup.set(h.groupId, [h])
    } else {
      loose.push(h)
    }
  }
  const sorted = [...groups].sort((a, b) => a.name.localeCompare(b.name, locale, { sensitivity: 'base' }))
  const out: HostSection<H, G>[] = []
  for (const g of sorted) {
    const members = byGroup.get(g.id) ?? []
    if (filtering && members.length === 0) continue
    out.push({ group: g, hosts: members })
  }
  if (loose.length > 0) out.push({ group: null, hosts: loose })
  return out
}

/** The section key used for folding: a group id, or this for the ungrouped hosts. */
export const UNGROUPED_KEY = '__ungrouped__'

/** The folded section keys as saved: a JSON list of strings. Anything else is none. */
export function parseFolded(raw: string | null): Set<string> {
  if (!raw) return new Set()
  try {
    const v: unknown = JSON.parse(raw)
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function serializeFolded(folded: Set<string>): string {
  return JSON.stringify([...folded].sort())
}
