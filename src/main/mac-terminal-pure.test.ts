import { describe, expect, it } from 'vitest'
import { loginCommandScript, shQuote, shownCommand } from './mac-terminal-pure'

describe('loginCommandScript', () => {
  it('runs zsh as a login shell, removes itself, exports quoted env, then keeps a shell open', () => {
    const script = loginCommandScript({
      command: `'/Users/jo ão/.local/bin/claude'`,
      env: { CLAUDE_CONFIG_DIR: `/Users/x/Library/Application Support/Argos/it's` },
      path: '/opt/homebrew/bin:/usr/bin'
    })
    const lines = script.split('\n')
    expect(lines[0]).toBe('#!/bin/zsh -l')
    expect(lines[1]).toBe('rm -f -- "$0"')
    expect(script).toContain(`export PATH='/opt/homebrew/bin:/usr/bin'`)
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='/Users/x/Library/Application Support/Argos/it'\\''s'`)
    expect(script).toContain(`'/Users/jo ão/.local/bin/claude'\nexec "\${SHELL:-/bin/zsh}" -l`)
  })

  it('skips env names that are not identifiers and cds when asked', () => {
    const script = loginCommandScript({ command: 'agy', env: { 'BAD;rm': 'x' }, cwd: '/tmp/a b' })
    expect(script).not.toContain('BAD')
    expect(script).toContain(`cd '/tmp/a b' || true`)
  })
})

describe('shownCommand', () => {
  it('prefixes quoted env assignments', () => {
    expect(shownCommand('codex login', { CODEX_HOME: '/a b' })).toBe(`CODEX_HOME='/a b' codex login`)
    expect(shownCommand('agy', {})).toBe('agy')
  })
})

describe('shQuote', () => {
  it('keeps apostrophes as a quoted backslash-escaped quote', () => {
    expect(shQuote(`it's`)).toBe("'it'\\''s'")
    expect(shQuote('a b')).toBe(`'a b'`)
  })
})
