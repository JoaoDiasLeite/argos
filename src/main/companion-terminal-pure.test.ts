import { describe, it, expect } from 'vitest'
import { chatSessionId, hookKey, shouldTell, terminalKey } from './companion-terminal-pure'

describe('shouldTell', () => {
  it('says the first word about a turn', () => {
    expect(shouldTell(undefined, 'finished')).toBe(true)
    expect(shouldTell(undefined, 'waiting')).toBe(true)
  })

  it('does not repeat itself: the hook a minute after the turn ended says nothing new', () => {
    expect(shouldTell('finished', 'finished')).toBe(false)
    expect(shouldTell('waiting', 'waiting')).toBe(false)
  })

  it('speaks up again when a finished chat turns out to need a permission', () => {
    expect(shouldTell('finished', 'waiting')).toBe(true)
    expect(shouldTell('waiting', 'finished')).toBe(false)
  })
})

describe('keys', () => {
  const terminals = new Map([
    ['chatterm_a', 'claude-1'],
    ['chatterm_b', 'claude-2']
  ])

  it('lands a hook about an embedded chat on that terminal’s key', () => {
    expect(hookKey('claude-2', terminals, '[argos] x')).toBe(terminalKey('chatterm_b'))
  })

  it('keys a session outside Argos by its id, and one with no id by its title', () => {
    expect(hookKey('claude-9', terminals, 't')).toBe('claude:claude-9')
    expect(hookKey(null, terminals, '[argos] x')).toBe('hook:[argos] x')
  })

  it('knows a chat terminal from any other pty', () => {
    expect(chatSessionId('chatterm_s1')).toBe('s1')
    expect(chatSessionId('chatterm_')).toBeNull()
    expect(chatSessionId('grid_3')).toBeNull()
  })
})
