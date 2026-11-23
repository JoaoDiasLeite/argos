import { describe, expect, it } from 'vitest'
import { allHostTags, favoritesFirst, filterHosts } from './host-filter'

const h = (name: string, extra: { favorite?: boolean; tags?: string[] } = {}) => ({
  name,
  host: `${name}.example.com`,
  username: 'root',
  ...extra
})

describe('favoritesFirst', () => {
  it('moves favourites up and keeps the order inside each group', () => {
    const list = [h('a'), h('b', { favorite: true }), h('c'), h('d', { favorite: true })]
    expect(favoritesFirst(list).map((x) => x.name)).toEqual(['b', 'd', 'a', 'c'])
  })
})

describe('allHostTags', () => {
  it('lists each tag once, ignoring case, sorted', () => {
    const list = [h('a', { tags: ['Prod', 'db'] }), h('b', { tags: ['prod', 'api'] })]
    expect(allHostTags(list)).toEqual(['api', 'db', 'Prod'])
  })
})

describe('filterHosts', () => {
  const list = [
    h('web', { tags: ['prod', 'eu'] }),
    h('db', { tags: ['prod'], favorite: true }),
    h('lab', { tags: ['eu'] }),
    h('plain')
  ]
  it('returns everything, favourites first, with no filter', () => {
    expect(filterHosts(list, '', []).map((x) => x.name)).toEqual(['db', 'web', 'lab', 'plain'])
  })
  it('searches tags as well as name, address and user', () => {
    expect(filterHosts(list, 'EU', []).map((x) => x.name)).toEqual(['web', 'lab'])
    expect(filterHosts(list, 'plain.example', []).map((x) => x.name)).toEqual(['plain'])
  })
  it('requires every selected tag', () => {
    expect(filterHosts(list, '', ['prod']).map((x) => x.name)).toEqual(['db', 'web'])
    expect(filterHosts(list, '', ['PROD', 'eu']).map((x) => x.name)).toEqual(['web'])
  })
})
