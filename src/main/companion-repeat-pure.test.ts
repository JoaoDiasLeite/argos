import { describe, it, expect } from 'vitest'
import { parseCapture } from './companion-nlu-pure'
import { cleanRepeat, nextOccurrence, nextTodo } from './companion-repeat-pure'
import type { CompanionTodo } from './companion-types'

// Monday 2 November 2026, 10:00 local, as in companion-nlu-pure.test.ts.
const NOW = new Date(2026, 10, 2, 10, 0)

const pad = (n: number): string => String(n).padStart(2, '0')
function local(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function read(text: string, now: Date = NOW): { title: string; when: string | null; every: string | null; monthDay?: number } {
  const p = parseCapture(text, { now })
  return {
    title: p.title,
    when: p.when ? (p.when.precision === 'day' ? local(p.when.at).slice(0, 10) : local(p.when.at)) : null,
    every: p.repeat?.every ?? null,
    ...(p.repeat?.monthDay ? { monthDay: p.repeat.monthDay } : {})
  }
}

describe('reading a repeat', () => {
  it.each([
    ['standup todos os dias às 9h30', 'Standup', '2026-11-03 09:30', 'day'],
    ['tomar o comprimido todos os dias', 'Tomar o comprimido', '2026-11-02', 'day'],
    ['ver o email diariamente às 18h', 'Ver o email', '2026-11-02 18:00', 'day'],
    ['enviar o relatório todas as sextas às 17h', 'Enviar o relatório', '2026-11-06 17:00', 'week'],
    ['backups todas as segundas-feiras às 11h', 'Backups', '2026-11-02 11:00', 'week'],
    ['reunião de equipa todas as segundas às 9h', 'Reunião de equipa', '2026-11-09 09:00', 'week'],
    ['regar as plantas todos os sábados', 'Regar as plantas', '2026-11-07', 'week'],
    ['rever tickets de segunda a sexta às 8h', 'Rever tickets', '2026-11-03 08:00', 'weekday'],
    ['picar o ponto nos dias úteis', 'Picar o ponto', '2026-11-02', 'weekday'],
    ['pagar a renda todos os meses dia 1', 'Pagar a renda', '2026-12-01', 'month'],
    ['limpar a caixa todas as semanas', 'Limpar a caixa', '2026-11-02', 'week'],
    ['call the bank every friday at 3pm', 'Call the bank', '2026-11-06 15:00', 'week'],
    ['water the plants every day', 'Water the plants', '2026-11-02', 'day'],
    ['check invoices every month', 'Check invoices', '2026-11-02', 'month']
  ])('%s', (text, title, when, every) => {
    const r = read(text)
    expect(r.title).toBe(title)
    expect(r.when).toBe(when)
    expect(r.every).toBe(every)
  })

  it('keeps the day of the month for a monthly repeat', () => {
    expect(read('pagar a renda todos os meses dia 31').monthDay).toBe(31)
  })

  it('moves a weekday repeat captured at the weekend to Monday', () => {
    expect(read('rever tickets de segunda a sexta', new Date(2026, 10, 7, 10, 0)).when).toBe('2026-11-09')
  })

  it('reads "dias úteis" as a repeat only with "todos os" / "nos" / "aos": otherwise it is a deadline', () => {
    expect(read('entregar o relatório em 5 dias úteis').every).toBeNull()
    expect(read('prazo de 3 dias úteis').every).toBeNull()
    expect(read('nos dias úteis às 8h').every).toBe('weekday')
  })

  it('reads "daily" and "weekly" as words, not repeats: the meeting is called that', () => {
    expect(read('daily às 10h').every).toBeNull()
    expect(read('preparar a weekly amanhã').every).toBeNull()
  })

  it('leaves questions and notes alone', () => {
    expect(parseCapture('o que tenho todos os dias?', { now: NOW }).repeat).toBeUndefined()
    expect(parseCapture('nota: todos os dias às 9h', { now: NOW }).repeat).toBeUndefined()
  })

  it('gives a repeat with no date a date, so it is not sent to the model as unsure', () => {
    const p = parseCapture('tomar o comprimido todos os dias', { now: NOW })
    expect(p.confidence).toBe(1)
    expect(p.matchedSpan).not.toBeNull()
  })
})

function todo(over: Partial<CompanionTodo>): CompanionTodo {
  return { id: 't1', title: 'Standup', remindAt: [], done: false, createdAt: 0, source: 'text', ...over }
}

const at = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

describe('the next occurrence', () => {
  it('steps a day, a week, a month', () => {
    const due = at(2026, 11, 2, 9, 30)
    const now = at(2026, 11, 2, 9, 40)
    expect(local(nextOccurrence(todo({ dueAt: due, repeat: { every: 'day' } }), now)!)).toBe('2026-11-03 09:30')
    expect(local(nextOccurrence(todo({ dueAt: due, repeat: { every: 'week' } }), now)!)).toBe('2026-11-09 09:30')
    expect(local(nextOccurrence(todo({ dueAt: due, repeat: { every: 'month', monthDay: 2 } }), now)!)).toBe('2026-12-02 09:30')
  })

  it('skips the weekend for Monday to Friday', () => {
    const friday = at(2026, 11, 6, 8)
    expect(local(nextOccurrence(todo({ dueAt: friday, repeat: { every: 'weekday' } }), friday + 60_000)!)).toBe('2026-11-09 08:00')
  })

  it('comes back to the 31st after a shorter month', () => {
    const jan31 = at(2027, 1, 31, 9)
    const feb = nextOccurrence(todo({ dueAt: jan31, repeat: { every: 'month', monthDay: 31 } }), jan31 + 60_000)!
    expect(local(feb)).toBe('2027-02-28 09:00')
    const mar = nextOccurrence(todo({ dueAt: feb, repeat: { every: 'month', monthDay: 31 } }), feb + 60_000)!
    expect(local(mar)).toBe('2027-03-31 09:00')
  })

  it('skips occurrences missed while it sat undone, instead of stacking them', () => {
    const due = at(2026, 11, 2, 9)
    expect(local(nextOccurrence(todo({ dueAt: due, repeat: { every: 'day' } }), at(2026, 11, 5, 12))!)).toBe('2026-11-06 09:00')
  })

  it('counts a day-precision occurrence as past once its day has started', () => {
    const day = at(2026, 11, 2)
    expect(local(nextOccurrence(todo({ dueAt: day, duePrecision: 'day', repeat: { every: 'day' } }), at(2026, 11, 2, 8))!)).toBe('2026-11-03 00:00')
  })

  // Lisbon (the machine TZ these run under) springs forward on 2027-03-28 at 01:00. In a
  // zone without that change these still hold: the wall time simply never moves.
  it('keeps the wall time across a DST change', () => {
    const nine = at(2027, 3, 27, 9)
    const sun = nextOccurrence(todo({ dueAt: nine, repeat: { every: 'day' } }), nine + 60_000)!
    expect(local(sun)).toBe('2027-03-28 09:00')
    expect(local(nextOccurrence(todo({ dueAt: sun, repeat: { every: 'day' } }), sun + 60_000)!)).toBe('2027-03-29 09:00')
  })

  it('skips a day whose wall time the spring-forward removes, rather than drift an hour', () => {
    const early = at(2027, 3, 27, 1, 30)
    const next = nextOccurrence(todo({ dueAt: early, repeat: { every: 'day' } }), early + 60_000)!
    const d = new Date(next)
    expect([d.getHours(), d.getMinutes()]).toEqual([1, 30])
    expect(next).toBeLessThanOrEqual(at(2027, 3, 29, 1, 30))
    expect(local(nextOccurrence(todo({ dueAt: next, repeat: { every: 'day' } }), next + 60_000)!).slice(11)).toBe('01:30')
  })

  it('is null without a repeat or a date', () => {
    expect(nextOccurrence(todo({ dueAt: at(2026, 11, 2) }), NOW.getTime())).toBeNull()
    expect(nextOccurrence(todo({ repeat: { every: 'day' } }), NOW.getTime())).toBeNull()
  })
})

describe('the next todo', () => {
  const rules = (when: { at: number; precision: 'day' | 'minute' }, explicit: boolean): number[] =>
    explicit ? [when.at] : [when.at - 10 * 60_000]

  it('copies the title, notes and repeat, with fresh state and its own reminders', () => {
    const due = at(2026, 11, 2, 9, 30)
    const done = todo({
      dueAt: due,
      duePrecision: 'minute',
      notes: 'sala 2',
      remindAt: [due - 600_000, due + 600_000],
      firedAt: [due - 600_000],
      repeat: { every: 'day' },
      sprintId: 's',
      sprintItemId: 'i',
      done: true
    })
    const next = nextTodo(done, at(2026, 11, 2, 9, 40), 'n1', rules)!
    expect(next).toMatchObject({ id: 'n1', title: 'Standup', notes: 'sala 2', done: false, duePrecision: 'minute', repeat: { every: 'day' } })
    expect(local(next.dueAt!)).toBe('2026-11-03 09:30')
    expect(next.remindAt.map(local)).toEqual(['2026-11-03 09:20'])
    expect(next.firedAt).toBeUndefined()
    expect(next.sprintItemId).toBeUndefined()
  })

  it('keeps "lembra-me" at the time itself', () => {
    const due = at(2026, 11, 2, 9)
    const next = nextTodo(todo({ dueAt: due, remindAt: [due], repeat: { every: 'day' } }), due + 60_000, 'n1', rules)!
    expect(next.remindAt.map(local)).toEqual(['2026-11-03 09:00'])
  })

  it('stays without reminders when the user removed them all', () => {
    const due = at(2026, 11, 2, 9)
    const next = nextTodo(todo({ dueAt: due, remindAt: [], repeat: { every: 'day' } }), due + 60_000, 'n1', rules)!
    expect(next.remindAt).toEqual([])
  })
})

describe('cleanRepeat', () => {
  it('keeps a known rule and drops anything else', () => {
    expect(cleanRepeat({ every: 'week' })).toEqual({ every: 'week' })
    expect(cleanRepeat({ every: 'month', monthDay: 15 })).toEqual({ every: 'month', monthDay: 15 })
    expect(cleanRepeat({ every: 'month', monthDay: 40 })).toEqual({ every: 'month' })
    expect(cleanRepeat({ every: 'year' })).toBeNull()
    expect(cleanRepeat('day')).toBeNull()
    expect(cleanRepeat(null)).toBeNull()
  })
})
