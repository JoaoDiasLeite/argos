import { cleanHostText, hostAuthSource } from './ssh-host-pure'

/**
 * A server group: the client a set of hosts belongs to ("Câmara X"), as RDM folders. One
 * level, no nesting. A group may carry a shared credential, which its hosts use only when
 * their auth source says `group`. Holds no secret, so it is kept as plain JSON in
 * `ssh-groups.json`.
 */
export interface SshGroup {
  id: string
  name: string
  credentialId?: string
}

/** The file's shape: an object, so the profile export carries it like the other JSON files. */
export interface SshGroupsFile {
  groups: SshGroup[]
}

export const MAX_GROUP_NAME_LENGTH = 80

/** What the renderer sends to create or edit a group. */
export interface SshGroupInput {
  id?: string
  name: string
  /** Empty or absent: no credential. */
  credentialId?: string
}

/** One group as read from the file or an import, or null when it is not one. Text is
 *  cleaned and capped; an empty credential id is dropped. */
export function cleanGroup(v: unknown): SshGroup | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const r = v as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') return null
  const name = cleanHostText(r.name).slice(0, MAX_GROUP_NAME_LENGTH).trim()
  if (!name) return null
  const out: SshGroup = { id: r.id, name }
  if (typeof r.credentialId === 'string' && r.credentialId) out.credentialId = r.credentialId
  return out
}

/** The groups a parsed file (or an imported one) holds, the broken entries and repeated
 *  ids dropped. */
export function groupsFromFile(v: unknown): SshGroup[] {
  const list = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>).groups : undefined
  if (!Array.isArray(list)) return []
  const out: SshGroup[] = []
  for (const raw of list) {
    const g = cleanGroup(raw)
    if (g && !out.some((x) => x.id === g.id)) out.push(g)
  }
  return out
}

/** Is `v` something the groups file may hold? The guard of the guarded JSON load. */
export function isGroupsFile(v: unknown): v is SshGroupsFile {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray((v as Record<string, unknown>).groups)
}

/** The fields a host needs here: which group it is in and where its login comes from. */
export interface GroupedHostRef {
  id: string
  groupId?: string
  authSource?: string
  credentialId?: string
}

/** Does `h` take its login from its group's credential? Only by explicit choice. */
export function inheritsFromGroup(h: GroupedHostRef): boolean {
  return hostAuthSource(h) === 'group'
}

/**
 * Deleting group `id`: its hosts move to "no group". Those that inherited its credential keep
 * `authSource: 'group'` and so have no login until edited (the confirm says so); they are
 * not switched to a login of their own, which would be an empty one. `orphaned` lists them.
 */
export function removeGroupFromHosts<T extends GroupedHostRef>(hosts: T[], id: string): { hosts: T[]; moved: number; orphaned: string[] } {
  let moved = 0
  const orphaned: string[] = []
  const out = hosts.map((h) => {
    if (h.groupId !== id) return h
    moved++
    if (inheritsFromGroup(h)) orphaned.push(h.id)
    const next = { ...h }
    delete next.groupId
    return next
  })
  return { hosts: out, moved, orphaned }
}

/** How many hosts are in group `id`, and how many of them inherit its credential. */
export function groupUsage(hosts: readonly GroupedHostRef[], id: string): { hosts: number; inheriting: number } {
  const members = hosts.filter((h) => h.groupId === id)
  return { hosts: members.length, inheriting: members.filter(inheritsFromGroup).length }
}

/** The groups that carry credential `id`. */
export function groupsUsingCredential(groups: readonly SshGroup[], id: string): SshGroup[] {
  return groups.filter((g) => g.credentialId === id)
}

/**
 * The ids of the hosts that log in with credential `id`: those linking it, and those
 * inheriting it from their group. What a credential edit evicts the pooled connections of.
 */
export function hostIdsLoggingInWith(hosts: readonly GroupedHostRef[], groups: readonly SshGroup[], id: string): string[] {
  const viaGroup = new Set(groupsUsingCredential(groups, id).map((g) => g.id))
  return hosts
    .filter((h) => {
      const source = hostAuthSource(h)
      if (source === 'group') return !!h.groupId && viaGroup.has(h.groupId)
      return source === 'credential' && h.credentialId === id
    })
    .map((h) => h.id)
}

/** The ids of the hosts that inherit group `id`'s credential: a change of that credential
 *  drops their pooled connections. */
export function hostIdsInheritingFrom(hosts: readonly GroupedHostRef[], id: string): string[] {
  return hosts.filter((h) => h.groupId === id && inheritsFromGroup(h)).map((h) => h.id)
}

/** Merge groups by id for a profile import: imported fields win, local-only groups stay. */
export function mergeGroups(local: SshGroup[], imported: SshGroup[]): SshGroup[] {
  const out = local.map((g) => ({ ...g }))
  for (const g of imported) {
    const idx = out.findIndex((x) => x.id === g.id)
    if (idx < 0) out.push({ ...g })
    else out[idx] = { ...g }
  }
  return out
}
