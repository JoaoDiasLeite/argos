import { describe, it, expect } from 'vitest'
import { CCSessionMeta } from '../types'
import { groupByAge, sortSessions } from './session-groups'

function s(over: Partial<CCSessionMeta>): CCSessionMeta {
  return {
    sessionId: 'x',
    encodedDir: 'd',
    realPath: '/p',
    title: 'T',
    preview: '',
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    sourceId: 'local',
    kind: 'local',
    tags: [],
    previewRedundant: false,
    ...over
  }
}

// A fixed clock: 2026-08-27, 09:00 local.
const NOW = new Date(2026, 7, 27, 9, 0, 0).getTime()
const DAY = 86_400_000
const at = (d: Date | number) => (typeof d === 'number' ? d : d.getTime())

describe('sortSessions', () => {
  it('puts the newest first by date', () => {
    const list = [s({ title: 'old', updatedAt: 1 }), s({ title: 'new', updatedAt: 9 })]
    expect(sortSessions(list, 'date').map((x) => x.title)).toEqual(['new', 'old'])
  })

  it('sorts titles the way a reader expects, accents included', () => {
    const list = [s({ title: 'Zebra' }), s({ title: 'Ácido' }), s({ title: 'banana' })]
    expect(sortSessions(list, 'title').map((x) => x.title)).toEqual(['Ácido', 'banana', 'Zebra'])
  })

  it('puts the longest first by size, breaking ties on date', () => {
    const list = [
      s({ title: 'a', messageCount: 5, updatedAt: 1 }),
      s({ title: 'b', messageCount: 50 }),
      s({ title: 'c', messageCount: 5, updatedAt: 9 })
    ]
    expect(sortSessions(list, 'size').map((x) => x.title)).toEqual(['b', 'c', 'a'])
  })

  it('does not mutate its input', () => {
    const list = [s({ title: 'a', updatedAt: 1 }), s({ title: 'b', updatedAt: 9 })]
    sortSessions(list, 'date')
    expect(list.map((x) => x.title)).toEqual(['a', 'b'])
  })
})

describe('groupByAge', () => {
  it('bands by calendar day, not by a rolling 24 hours', () => {
    // 23:00 last night is ten hours old at 09:00, and calling it "Today" is the kind
    // of wrong label that makes a reader stop trusting the rest of them.
    const lastNight = at(new Date(2026, 7, 26, 23, 0))
    const [g] = groupByAge([s({ updatedAt: lastNight })], NOW)
    expect(g.label).toBe('Yesterday')
  })

  it('counts a session from earlier today as Today', () => {
    const [g] = groupByAge([s({ updatedAt: at(new Date(2026, 7, 27, 1, 30)) })], NOW)
    expect(g.label).toBe('Today')
  })

  it('walks the bands in order', () => {
    const list = [
      s({ title: 'now', updatedAt: NOW - 3600_000 }),
      s({ title: 'yest', updatedAt: NOW - 26 * 3600_000 }),
      s({ title: 'week', updatedAt: NOW - 4 * DAY }),
      s({ title: 'month', updatedAt: NOW - 20 * DAY }),
      s({ title: 'ancient', updatedAt: NOW - 200 * DAY })
    ]
    expect(groupByAge(list, NOW).map((g) => g.label)).toEqual([
      'Today',
      'Yesterday',
      'Last 7 days',
      'Last 30 days',
      'Older'
    ])
  })

  it('drops bands with nothing in them', () => {
    const list = [s({ updatedAt: NOW - 3600_000 }), s({ updatedAt: NOW - 200 * DAY })]
    expect(groupByAge(list, NOW).map((g) => g.label)).toEqual(['Today', 'Older'])
  })

  it('keeps the given order inside a band', () => {
    const list = [
      s({ title: 'first', updatedAt: NOW - 3600_000 }),
      s({ title: 'second', updatedAt: NOW - 7200_000 })
    ]
    expect(groupByAge(list, NOW)[0].sessions.map((x) => x.title)).toEqual(['first', 'second'])
  })

  it('puts a session with no timestamp at all in Older', () => {
    expect(groupByAge([s({ updatedAt: 0 })], NOW)[0].label).toBe('Older')
  })

  it('returns nothing for an empty list', () => {
    expect(groupByAge([], NOW)).toEqual([])
  })
})
