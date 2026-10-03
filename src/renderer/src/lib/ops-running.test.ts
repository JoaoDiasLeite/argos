import { describe, it, expect } from 'vitest'
import { isOpsTerminalId, markOpsEnded, markOpsRunning, summarizeOpsRunning } from './ops-running'

describe('markOpsRunning', () => {
  it('adds an ops terminal', () => {
    expect([...markOpsRunning(new Set(), 'opsterm_abc')]).toEqual(['opsterm_abc'])
  })

  it('ignores a terminal that is not an ops one', () => {
    const none = new Set<string>()
    expect(markOpsRunning(none, 'chat-1')).toBe(none)
  })

  it('returns the same set when the id is already there', () => {
    const one = new Set(['opsterm_abc'])
    expect(markOpsRunning(one, 'opsterm_abc')).toBe(one)
  })

  it('does not mutate the set it was given', () => {
    const before = new Set(['opsterm_a'])
    markOpsRunning(before, 'opsterm_b')
    expect([...before]).toEqual(['opsterm_a'])
  })
})

describe('markOpsEnded', () => {
  it('removes a running terminal', () => {
    expect([...markOpsEnded(new Set(['opsterm_a', 'opsterm_b']), 'opsterm_a')]).toEqual(['opsterm_b'])
  })

  it('returns the same set for a terminal it never had, such as a chat exiting', () => {
    const one = new Set(['opsterm_a'])
    expect(markOpsEnded(one, 'chat-1')).toBe(one)
  })
})

describe('summarizeOpsRunning', () => {
  const running = new Set(['opsterm_a'])

  it('counts the running interventions', () => {
    expect(summarizeOpsRunning(running, [])).toEqual({ count: 1, needsYou: false })
    expect(summarizeOpsRunning(new Set(), [])).toEqual({ count: 0, needsYou: false })
  })

  it('needs you when an ops approval waits on a running intervention', () => {
    expect(summarizeOpsRunning(running, [{ appSessionId: 'opsterm_a', ops: {} }]).needsYou).toBe(true)
  })

  it('does not need you for a chat approval, or an ops one from a terminal that is not running', () => {
    expect(summarizeOpsRunning(running, [{ appSessionId: 'chat-1' }]).needsYou).toBe(false)
    expect(summarizeOpsRunning(running, [{ appSessionId: 'opsterm_gone', ops: {} }]).needsYou).toBe(false)
  })
})

describe('isOpsTerminalId', () => {
  it('matches only the ops prefix', () => {
    expect(isOpsTerminalId('opsterm_x1')).toBe(true)
    expect(isOpsTerminalId('chat-opsterm_x1')).toBe(false)
  })
})
