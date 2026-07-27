import { describe, it, expect } from 'vitest'
import { pickNewestClaudeBackup, isClaudeBinBroken } from './claude-cli-pure'

describe('pickNewestClaudeBackup', () => {
  it('returns null when there is no backup', () => {
    expect(pickNewestClaudeBackup(['claude.exe', 'README.md'])).toBeNull()
    expect(pickNewestClaudeBackup([])).toBeNull()
  })

  it('finds the single backup', () => {
    expect(pickNewestClaudeBackup(['claude.exe.old.1785147984009'])).toBe('claude.exe.old.1785147984009')
  })

  it('picks the newest of several by numeric timestamp, not string order', () => {
    // 999... is a shorter string but an older epoch than 1785...; string sorting gets this wrong.
    const names = ['claude.exe.old.1785147984009', 'claude.exe.old.999999999999', 'claude.exe.old.1785147000000']
    expect(pickNewestClaudeBackup(names)).toBe('claude.exe.old.1785147984009')
  })

  it('ignores names that only look like backups', () => {
    expect(pickNewestClaudeBackup(['claude.exe.old', 'claude.exe.old.abc', 'claude.exe.bak.123'])).toBeNull()
  })
})

describe('isClaudeBinBroken', () => {
  it('is broken when the exe is gone but a backup remains', () => {
    expect(isClaudeBinBroken(['claude.exe.old.1785147984009'])).toBe(true)
  })

  it('is fine when the exe is present, backup or not', () => {
    expect(isClaudeBinBroken(['claude.exe'])).toBe(false)
    expect(isClaudeBinBroken(['claude.exe', 'claude.exe.old.1785147984009'])).toBe(false)
  })

  it('is not "broken" when there is nothing to restore from', () => {
    // Nothing we can repair — a missing bin/ entirely is a different problem (not installed).
    expect(isClaudeBinBroken([])).toBe(false)
  })
})
