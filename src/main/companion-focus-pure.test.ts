import { describe, expect, it } from 'vitest'
import { MAX_SPAN_MS, isSaveThisCommand, parseSpanCommand } from './companion-focus-pure'

describe('isSaveThisCommand', () => {
  it('is the few ways of asking for the clipboard, and nothing else', () => {
    for (const s of ['guarda isto', 'Guarda isto!', 'save this', 'keep this', 'guarda o clipboard', 'save clipboard']) {
      expect(isSaveThisCommand(s)).toBe(true)
    }
    expect(isSaveThisCommand('guarda isto para amanhã')).toBe(false)
    expect(isSaveThisCommand('nota: guarda isto')).toBe(false)
  })
})

const MIN = 60_000

describe('parseSpanCommand', () => {
  it.each([
    ['foca 25', 'focus', 25 * MIN],
    ['Foca 25 min', 'focus', 25 * MIN],
    ['foco 1h', 'focus', 60 * MIN],
    ['focus 45 minutes', 'focus', 45 * MIN],
    ['focus for 1h30', 'focus', 90 * MIN],
    ['pomodoro', 'focus', 25 * MIN],
    ['foca', 'focus', 25 * MIN],
    ['timer 5 min', 'timer', 5 * MIN],
    ['timer 5', 'timer', 5 * MIN],
    ['temporizador 10', 'timer', 10 * MIN],
    ['cronómetro 20 min', 'timer', 20 * MIN],
    ['alarme em 15 min', 'timer', 15 * MIN],
    ['alarm in 2 hours', 'timer', 120 * MIN]
  ])('%s → %s of %i ms', (line, kind, ms) => {
    expect(parseSpanCommand(line)).toEqual({ kind, ms })
  })

  it('is nothing for a todo that starts with the word, a timer without a span, or too long', () => {
    expect(parseSpanCommand('foca na factura da Sofia')).toBeNull()
    expect(parseSpanCommand('timer')).toBeNull()
    expect(parseSpanCommand('timer do forno amanhã')).toBeNull()
    expect(parseSpanCommand(`focus ${MAX_SPAN_MS / MIN + 1}`)).toBeNull()
    expect(parseSpanCommand('ligar ao Rui amanhã')).toBeNull()
    expect(parseSpanCommand('')).toBeNull()
  })
})
