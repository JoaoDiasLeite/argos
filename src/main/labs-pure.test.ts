import { describe, expect, it } from 'vitest'
import {
  chatLoginAnswered,
  labsActionAllowed,
  labsFromConfig,
  mayAskOnConnect,
  mayAutoStartForwards,
  tryKeyboardFor
} from './labs-pure'

describe('labsFromConfig', () => {
  it('is on only for a literal true', () => {
    expect(labsFromConfig(true)).toBe(true)
    for (const v of [undefined, null, false, 'true', 1, {}]) expect(labsFromConfig(v)).toBe(false)
  })
})

describe('mayAskOnConnect', () => {
  it('asks only with labs on and someone there to answer', () => {
    expect(mayAskOnConnect(true, true)).toBe(true)
    expect(mayAskOnConnect(true, false)).toBe(false)
    expect(mayAskOnConnect(false, true)).toBe(false)
    expect(mayAskOnConnect(false, false)).toBe(false)
  })
})

describe('tryKeyboardFor', () => {
  it('never tries keyboard-interactive with labs off, even with a saved password', () => {
    expect(tryKeyboardFor(false, { canAsk: true, authType: 'password', hasPassword: true })).toBe(false)
    expect(tryKeyboardFor(false, { canAsk: false, authType: 'password', hasPassword: true })).toBe(false)
  })
  it('tries it with labs on when it can be answered', () => {
    expect(tryKeyboardFor(true, { canAsk: true, authType: 'key', hasPassword: false })).toBe(true)
    expect(tryKeyboardFor(true, { canAsk: false, authType: 'password', hasPassword: true })).toBe(true)
  })
  it('does not try it with labs on when nothing could answer', () => {
    expect(tryKeyboardFor(true, { canAsk: false, authType: 'password', hasPassword: false })).toBe(false)
    expect(tryKeyboardFor(true, { canAsk: false, authType: 'agent', hasPassword: false })).toBe(false)
  })
})

describe('chatLoginAnswered', () => {
  it('answers the chat terminal login only with labs on and something to answer', () => {
    expect(chatLoginAnswered(true, 1)).toBe(true)
    expect(chatLoginAnswered(true, 0)).toBe(false)
    expect(chatLoginAnswered(false, 2)).toBe(false)
  })
})

describe('mayAutoStartForwards and labsActionAllowed', () => {
  it('follow the switch', () => {
    expect(mayAutoStartForwards(true)).toBe(true)
    expect(mayAutoStartForwards(false)).toBe(false)
    expect(labsActionAllowed(true)).toBe(true)
    expect(labsActionAllowed(false)).toBe(false)
  })
})
