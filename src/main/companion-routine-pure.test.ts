import { describe, expect, it } from 'vitest'
import { dayKey, isNight, routineMoment } from './companion-routine-pure'

const at = (h: number, m = 0, s = 0): number => new Date(2026, 10, 5, h, m, s).getTime()

describe('isNight', () => {
  it('runs from ten at night to the morning hour', () => {
    expect(isNight(at(21, 59), 9)).toBe(false)
    expect(isNight(at(22), 9)).toBe(true)
    expect(isNight(at(3), 9)).toBe(true)
    expect(isNight(at(8, 59), 9)).toBe(true)
    expect(isNight(at(9), 9)).toBe(false)
    expect(isNight(at(6, 30), 7)).toBe(true)
    expect(isNight(at(7), 7)).toBe(false)
  })
})

describe('routineMoment', () => {
  it('is the stretch in the five minutes after the morning hour', () => {
    expect(routineMoment(at(9), 9)).toBe('stretch')
    expect(routineMoment(at(9, 4, 59), 9)).toBe('stretch')
    expect(routineMoment(at(9, 5), 9)).toBeNull()
    expect(routineMoment(at(10, 1), 9)).toBeNull()
    expect(routineMoment(at(8, 1), 8)).toBe('stretch')
  })

  it('is the yawn after six', () => {
    expect(routineMoment(at(18, 2), 9)).toBe('yawn')
    expect(routineMoment(at(18, 6), 9)).toBeNull()
    expect(routineMoment(at(17, 59), 9)).toBeNull()
  })
})

describe('dayKey', () => {
  it('is one key per local day', () => {
    expect(dayKey(at(0, 0, 1))).toBe(dayKey(at(23, 59, 59)))
    expect(dayKey(at(23, 59, 59))).not.toBe(dayKey(new Date(2026, 10, 6, 0, 0, 1).getTime()))
  })
})
