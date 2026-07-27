import { describe, it, expect } from 'vitest'
import { isSafeRemotePath, parseHistoryLines } from './sftp-pure'

describe('isSafeRemotePath', () => {
  it('accepts absolute POSIX paths', () => {
    expect(isSafeRemotePath('/home/user')).toBe(true)
    expect(isSafeRemotePath('/')).toBe(true)
    expect(isSafeRemotePath('/home/user/project/file.txt')).toBe(true)
  })

  it('rejects non-absolute paths', () => {
    expect(isSafeRemotePath('relative/path')).toBe(false)
    expect(isSafeRemotePath('file.txt')).toBe(false)
    expect(isSafeRemotePath('')).toBe(false)
    expect(isSafeRemotePath('~/home')).toBe(false)
  })

  it('rejects paths containing a ".." segment, anywhere', () => {
    expect(isSafeRemotePath('/home/user/..')).toBe(false)
    expect(isSafeRemotePath('/home/../etc/passwd')).toBe(false)
    expect(isSafeRemotePath('/../etc')).toBe(false)
    expect(isSafeRemotePath('/home/user/../../etc')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isSafeRemotePath(undefined)).toBe(false)
    expect(isSafeRemotePath(null)).toBe(false)
    expect(isSafeRemotePath(42)).toBe(false)
    expect(isSafeRemotePath({})).toBe(false)
  })
})

describe('parseHistoryLines', () => {
  it('splits raw history text into a command list', () => {
    expect(parseHistoryLines('ls -la\ncd project\ngit status')).toEqual(['ls -la', 'cd project', 'git status'])
  })

  it('strips zsh extended-history timestamp prefixes', () => {
    const raw = ': 1700000000:0;ls -la\n: 1700000005:0;git status'
    expect(parseHistoryLines(raw)).toEqual(['ls -la', 'git status'])
  })

  it('de-dupes only consecutive repeats, not all repeats', () => {
    const raw = 'ls\nls\nls\ncd ..\nls'
    expect(parseHistoryLines(raw)).toEqual(['ls', 'cd ..', 'ls'])
  })

  it('drops blank lines', () => {
    expect(parseHistoryLines('ls\n\n\ncd project\n')).toEqual(['ls', 'cd project'])
  })

  it('caps the result to the most recent N entries, preserving order', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `cmd${i}`).join('\n')
    expect(parseHistoryLines(raw, 3)).toEqual(['cmd7', 'cmd8', 'cmd9'])
  })

  it('handles CRLF line endings', () => {
    expect(parseHistoryLines('ls\r\ncd project\r\n')).toEqual(['ls', 'cd project'])
  })

  it('returns an empty array for empty input', () => {
    expect(parseHistoryLines('')).toEqual([])
  })
})
