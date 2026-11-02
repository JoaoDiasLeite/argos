import { describe, it, expect } from 'vitest'
import { makeT } from '../../../shared/i18n'
import {
  chipLabel,
  dayLine,
  dayOffset,
  dayWord,
  defaultPickTime,
  formatShortDate,
  formatTime,
  lateSpan,
  rowWhen,
  toLocalInputValue,
  whenPhrase
} from './format'

const pt = makeT('pt-PT')
const en = makeT('en')
// Monday 2 Nov 2026, 10:30 local.
const now = new Date(2026, 10, 2, 10, 30).getTime()
const at = (d: number, h: number, m = 0): number => new Date(2026, 10, d, h, m).getTime()

describe('companion format', () => {
  it('counts calendar days, not 24 h spans', () => {
    expect(dayOffset(at(2, 23, 59), now)).toBe(0)
    expect(dayOffset(at(3, 0, 1), now)).toBe(1)
    expect(dayOffset(at(1, 23), now)).toBe(-1)
  })

  it('writes times as 24-hour, two-digit', () => {
    expect(formatTime(at(3, 14), 'pt-PT')).toBe('14:00')
    expect(formatTime(at(3, 9, 5), 'en-GB')).toBe('09:05')
    expect(formatTime(at(3, 14), 'en-US')).toBe('14:00')
  })

  it('writes a short date without the dots pt-PT adds', () => {
    expect(formatShortDate(at(3, 14), 'pt-PT')).toBe('ter 3 nov')
    expect(formatShortDate(at(3, 14), 'en-GB')).toBe('Tue 3 Nov')
  })

  it('starts a line with a relative day or a capitalised date', () => {
    expect(dayWord(at(2, 14), now, 'pt-PT', pt)).toBe('Hoje')
    expect(dayWord(at(3, 14), now, 'pt-PT', pt)).toBe('Amanhã')
    expect(dayWord(at(1, 14), now, 'pt-PT', pt)).toBe('Ontem')
    expect(dayWord(at(5, 14), now, 'pt-PT', pt)).toBe('Qui 5 nov')
  })

  it('builds the receipt day line', () => {
    expect(dayLine(at(3, 14), now, 'pt-PT', pt)).toBe('Amanhã, ter 3 nov')
    expect(dayLine(at(3, 14), now, 'en-GB', en)).toBe('Tomorrow, Tue 3 Nov')
    expect(dayLine(at(6, 14), now, 'pt-PT', pt)).toBe('Sex 6 nov')
  })

  it('labels the needs-title chip and question', () => {
    expect(chipLabel(at(3, 14), 'minute', now, 'pt-PT', pt)).toBe('amanhã, 14:00')
    expect(chipLabel(at(3, 9), 'day', now, 'pt-PT', pt)).toBe('amanhã')
    expect(pt('companion.needsTitle.question', { when: whenPhrase(at(3, 14), 'minute', now, 'pt-PT', pt) })).toBe(
      'O que é para amanhã às 14:00?'
    )
    expect(en('companion.needsTitle.question', { when: whenPhrase(at(3, 14), 'minute', now, 'en-GB', en) })).toBe(
      "What's for tomorrow at 14:00?"
    )
  })

  it('shows a row time today and a day otherwise', () => {
    expect(rowWhen(at(2, 8), now, 'pt-PT', pt)).toBe('08:00')
    expect(rowWhen(at(1, 18), now, 'pt-PT', pt)).toBe('Ontem')
  })

  it('says how late coarsely', () => {
    expect(lateSpan(0.2, pt)).toBe('1 min')
    expect(lateSpan(25, pt)).toBe('25 min')
    expect(lateSpan(60, pt)).toBe('1 h')
    expect(lateSpan(119, pt)).toBe('1 h')
    expect(lateSpan(3 * 24 * 60 + 5, pt)).toBe('3 d')
    expect(pt('companion.reminder.late', { span: lateSpan(60, pt) })).toBe('atrasado 1 h')
  })

  it('round-trips a datetime-local value and picks the next whole hour', () => {
    expect(toLocalInputValue(at(3, 9, 5))).toBe('2026-11-03T09:05')
    expect(defaultPickTime(now)).toBe(at(2, 12))
    expect(defaultPickTime(at(2, 10, 20))).toBe(at(2, 11))
  })
})
