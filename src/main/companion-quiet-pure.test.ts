import { describe, it, expect } from 'vitest'
import {
  DEFAULT_QUIET_MS,
  isQuiet,
  parseQuietCommand,
  quietUntilDay,
  restingPetState,
  tomorrowAt
} from './companion-quiet-pure'
import { todayQuery } from './companion-capture-pure'
import type { CompanionTodo } from './companion-types'

// Monday 2 November 2026, 14:30 local.
const now = new Date(2026, 10, 2, 14, 30).getTime()
const ctx = { now, morningHour: 9 }
const H = 60 * 60_000
const M = 60_000

const until = (text: string): number | null => {
  const r = parseQuietCommand(text, ctx)
  return r && 'untilMs' in r ? r.untilMs : null
}
const isOff = (text: string): boolean => {
  const r = parseQuietCommand(text, ctx)
  return !!r && 'off' in r
}

describe('parseQuietCommand: muting', () => {
  it.each([
    ['shh', H],
    ['Shh', H],
    ['shhh', H],
    ['shh.', H],
    ['  shh  ', H],
    ['shh 1h', H],
    ['shh 30m', 30 * M],
    ['shh 30 min', 30 * M],
    ['shh 2 horas', 2 * H],
    ['shh 1h30', 90 * M],
    ['shh 1,5h', 90 * M],
    ['silêncio', H],
    ['Silêncio!', H],
    ['silencio', H],
    ['silêncio 1h', H],
    ['silêncio por 1 hora', H],
    ['silêncio uma hora', H],
    ['silêncio meia hora', 30 * M],
    ['chiu', H],
    ['quiet', H],
    ['quiet 1h', H],
    ['quiet for 20 minutes', 20 * M],
    ['quiet half an hour', 30 * M],
    ['mute 2 hours', 2 * H],
    ['not now', H],
    ['Not now.', H],
    ['não agora', H],
    ['agora não', H]
  ])('%s', (text, ms) => {
    expect(until(text)).toBe(now + ms)
  })

  it('"até amanhã" is tomorrow at the morning hour', () => {
    const tomorrow9 = new Date(2026, 10, 3, 9, 0).getTime()
    expect(until('silêncio até amanhã')).toBe(tomorrow9)
    expect(until('shh até amanhã')).toBe(tomorrow9)
    expect(until('quiet until tomorrow')).toBe(tomorrow9)
    expect(until('shh amanhã')).toBe(tomorrow9)
    expect(parseQuietCommand('shh até amanhã', { now, morningHour: 8 })).toEqual({ untilMs: new Date(2026, 10, 3, 8).getTime() })
  })

  it('defaults to an hour', () => {
    expect(until('shh')).toBe(now + DEFAULT_QUIET_MS)
  })
})

describe('parseQuietCommand: waking', () => {
  it.each(['acorda', 'Acorda!', 'fala', 'podes falar', 'wake up', 'unmute', 'shh off', 'silêncio off', 'silêncio desliga', 'quiet off'])(
    '%s',
    (text) => {
      expect(isOff(text)).toBe(true)
    }
  )
})

describe('parseQuietCommand: everything else is a capture', () => {
  it.each([
    'shh, ligar ao Rui',
    'shh ligar ao Rui',
    'silêncio na biblioteca amanhã',
    'quiet room booking at 3pm',
    'comprar shh',
    'acorda o Rui às 7h',
    'fala com a Ana amanhã',
    'not now but tomorrow call Rui',
    'shh 0m',
    'shh 48h',
    'shh 5 dias',
    '',
    '   '
  ])('%s', (text) => {
    expect(parseQuietCommand(text, ctx)).toBeNull()
  })
})

describe('tomorrowAt', () => {
  it('builds from the calendar across a DST change', () => {
    // Europe/Lisbon falls back on 25 Oct 2026; whatever the zone, the hour stays the hour.
    const sat = new Date(2026, 9, 24, 22, 0).getTime()
    const d = new Date(tomorrowAt(sat, 9))
    expect([d.getDate(), d.getHours(), d.getMinutes()]).toEqual([25, 9, 0])
  })
  it('rolls the month', () => {
    const d = new Date(tomorrowAt(new Date(2026, 10, 30, 23).getTime(), 9))
    expect([d.getMonth(), d.getDate()]).toEqual([11, 1])
  })
})

describe('the pet while muted', () => {
  it('rests in shh while dnd is ahead, idle otherwise', () => {
    expect(restingPetState(now + H, now)).toBe('shh')
    expect(restingPetState(now, now)).toBe('idle')
    expect(restingPetState(now - 1, now)).toBe('idle')
    expect(restingPetState(null, now)).toBe('idle')
    expect(restingPetState(undefined, now)).toBe('idle')
  })
  it('isQuiet', () => {
    expect(isQuiet(now + 1, now)).toBe(true)
    expect(isQuiet(now, now)).toBe(false)
    expect(isQuiet(null, now)).toBe(false)
  })
})

describe('quietUntilDay', () => {
  it('today, tomorrow, later', () => {
    expect(quietUntilDay(now + H, now)).toBe('today')
    expect(quietUntilDay(new Date(2026, 10, 3, 9).getTime(), now)).toBe('tomorrow')
    expect(quietUntilDay(new Date(2026, 10, 4, 9).getTime(), now)).toBe('later')
  })
})

describe('todayQuery', () => {
  const todo = (id: string, over: Partial<CompanionTodo>): CompanionTodo => ({
    id,
    title: id,
    remindAt: [],
    done: false,
    createdAt: 0,
    source: 'text',
    ...over
  })
  it("lists today's open todos and the overdue ones, soonest first, as a query for today", () => {
    const todos = [
      todo('later-today', { dueAt: new Date(2026, 10, 2, 18).getTime() }),
      todo('this-morning', { dueAt: new Date(2026, 10, 2, 9).getTime() }),
      todo('done', { dueAt: new Date(2026, 10, 2, 11).getTime(), done: true }),
      todo('tomorrow', { dueAt: new Date(2026, 10, 3, 9).getTime() }),
      todo('yesterday', { dueAt: new Date(2026, 10, 1, 9).getTime() }),
      todo('someday', {}),
      todo('reminder-only', { remindAt: [new Date(2026, 10, 2, 16).getTime()] })
    ]
    const r = todayQuery(todos, now)
    expect(r.kind).toBe('query')
    expect(r.results.map((t) => t.id)).toEqual(['yesterday', 'this-morning', 'reminder-only', 'later-today'])
    expect(r.parsed.intent).toBe('query')
    expect(r.parsed.queryRange).toEqual({ from: new Date(2026, 10, 2).getTime(), to: new Date(2026, 10, 3).getTime() })
  })
})
