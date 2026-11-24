import { describe, it, expect } from 'vitest'
import { groupHosts, parseFolded, serializeFolded } from './host-groups'
import { filterHosts } from './host-filter'

const groups = [
  { id: 'g_z', name: 'Zeta' },
  { id: 'g_a', name: 'água' },
  { id: 'g_e', name: 'Empty' }
]

const hosts = [
  { id: '1', name: 'one', host: 'h1', username: 'u', groupId: 'g_z' },
  { id: '2', name: 'two', host: 'h2', username: 'u', groupId: 'g_a', tags: ['db'] },
  { id: '3', name: 'three', host: 'h3', username: 'u' },
  { id: '4', name: 'four', host: 'h4', username: 'u', groupId: 'g_z', favorite: true },
  { id: '5', name: 'five', host: 'h5', username: 'u', groupId: 'g_gone' }
]

const ids = (sections: ReturnType<typeof groupHosts>) => sections.map((s) => [s.group?.id ?? null, s.hosts.map((h) => (h as { id: string }).id)])

describe('groupHosts', () => {
  it('sorts groups by name, keeps favourites first inside each, and lists ungrouped hosts last', () => {
    const sections = groupHosts(filterHosts(hosts, '', []), groups, false)
    expect(ids(sections)).toEqual([
      ['g_a', ['2']],
      ['g_e', []],
      ['g_z', ['4', '1']],
      [null, ['3', '5']]
    ])
  })

  it('hides a group with no matching host while a filter is on', () => {
    const sections = groupHosts(filterHosts(hosts, '', ['db']), groups, true)
    expect(ids(sections)).toEqual([['g_a', ['2']]])
  })

  it('puts a host whose group is gone with the ungrouped ones', () => {
    expect(ids(groupHosts(hosts, [], false))).toEqual([[null, ['1', '2', '3', '4', '5']]])
  })

  it('has no ungrouped section when every host is in a group', () => {
    expect(ids(groupHosts([hosts[0]], groups, false)).map((s) => s[0])).toEqual(['g_a', 'g_e', 'g_z'])
  })
})

describe('folded groups in storage', () => {
  it('round-trips and tolerates garbage', () => {
    expect([...parseFolded(serializeFolded(new Set(['b', 'a'])))]).toEqual(['a', 'b'])
    expect(parseFolded(null).size).toBe(0)
    expect(parseFolded('{not json').size).toBe(0)
    expect(parseFolded('{"a":1}').size).toBe(0)
    expect([...parseFolded('["x", 3, null]')]).toEqual(['x'])
  })
})
