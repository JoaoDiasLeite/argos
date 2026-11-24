import { describe, it, expect } from 'vitest'
import {
  cleanGroup,
  groupUsage,
  groupsFromFile,
  groupsUsingCredential,
  hostIdsInheritingFrom,
  hostIdsLoggingInWith,
  isGroupsFile,
  mergeGroups,
  removeGroupFromHosts,
  type SshGroup
} from './ssh-group-pure'

const groups: SshGroup[] = [
  { id: 'grp_x', name: 'Câmara X', credentialId: 'cred_x' },
  { id: 'grp_y', name: 'Câmara Y' }
]

const hosts = [
  { id: 'a', groupId: 'grp_x', authSource: 'group' },
  { id: 'b', groupId: 'grp_x', authSource: 'own' },
  { id: 'c', groupId: 'grp_x', credentialId: 'cred_x' },
  { id: 'd', groupId: 'grp_y', authSource: 'credential', credentialId: 'cred_x' },
  { id: 'e' }
]

describe('reading groups', () => {
  it('cleans a group and drops what is not one', () => {
    expect(cleanGroup({ id: 'g', name: '  Câmara​ X ', credentialId: '' })).toEqual({ id: 'g', name: 'Câmara X' })
    expect(cleanGroup({ id: 'g', name: 'n', credentialId: 'c', extra: 1 })).toEqual({ id: 'g', name: 'n', credentialId: 'c' })
    expect(cleanGroup({ id: 'g', name: '   ' })).toBeNull()
    expect(cleanGroup({ name: 'n' })).toBeNull()
    expect(cleanGroup(['g'])).toBeNull()
    expect(cleanGroup({ id: 'g', name: 'x'.repeat(200) })?.name).toHaveLength(80)
  })

  it('reads the file shape, skipping broken entries and repeated ids', () => {
    expect(groupsFromFile({ groups: [{ id: 'a', name: 'A' }, { id: 'a', name: 'again' }, null, { id: 'b' }] })).toEqual([{ id: 'a', name: 'A' }])
    expect(groupsFromFile(undefined)).toEqual([])
    expect(groupsFromFile([{ id: 'a', name: 'A' }])).toEqual([])
    expect(isGroupsFile({ groups: [] })).toBe(true)
    expect(isGroupsFile([])).toBe(false)
  })
})

describe('deleting a group', () => {
  it('moves its hosts to no group and lists those left without a login', () => {
    const res = removeGroupFromHosts(hosts, 'grp_x')
    expect(res.moved).toBe(3)
    expect(res.orphaned).toEqual(['a'])
    expect(res.hosts.filter((h) => h.groupId === 'grp_x')).toEqual([])
    // The inheriting host keeps its choice: it is not handed an empty login of its own.
    expect(res.hosts.find((h) => h.id === 'a')).toEqual({ id: 'a', authSource: 'group' })
    expect(res.hosts.find((h) => h.id === 'd')).toBe(hosts[3])
  })

  it('leaves the list alone for a group nobody is in', () => {
    const res = removeGroupFromHosts(hosts, 'grp_none')
    expect(res).toEqual({ hosts, moved: 0, orphaned: [] })
  })
})

describe('who uses what', () => {
  it('counts the hosts in a group and those inheriting from it', () => {
    expect(groupUsage(hosts, 'grp_x')).toEqual({ hosts: 3, inheriting: 1 })
    expect(groupUsage(hosts, 'grp_y')).toEqual({ hosts: 1, inheriting: 0 })
  })

  it('finds the hosts logging in with a credential, linked or inherited', () => {
    expect(hostIdsLoggingInWith(hosts, groups, 'cred_x')).toEqual(['a', 'c', 'd'])
    // Without the groups, the inheriting host is not counted.
    expect(hostIdsLoggingInWith(hosts, [], 'cred_x')).toEqual(['c', 'd'])
    // A host with its own login never counts, whatever stray link it carries.
    expect(hostIdsLoggingInWith([{ id: 'z', authSource: 'own', credentialId: 'cred_x' }], groups, 'cred_x')).toEqual([])
  })

  it('finds the groups carrying a credential and the hosts inheriting a group', () => {
    expect(groupsUsingCredential(groups, 'cred_x').map((g) => g.id)).toEqual(['grp_x'])
    expect(hostIdsInheritingFrom(hosts, 'grp_x')).toEqual(['a'])
    expect(hostIdsInheritingFrom(hosts, 'grp_y')).toEqual([])
  })
})

describe('profile import', () => {
  it('merges by id, imported fields winning, local-only groups kept', () => {
    const merged = mergeGroups(groups, [
      { id: 'grp_x', name: 'Câmara X (renamed)' },
      { id: 'grp_z', name: 'Z', credentialId: 'cred_z' }
    ])
    expect(merged).toEqual([
      { id: 'grp_x', name: 'Câmara X (renamed)' },
      { id: 'grp_y', name: 'Câmara Y' },
      { id: 'grp_z', name: 'Z', credentialId: 'cred_z' }
    ])
  })
})
