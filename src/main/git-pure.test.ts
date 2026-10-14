import { describe, it, expect } from 'vitest'
import { parseNumstat, repoNameFromRemoteUrl } from './git'

describe('repoNameFromRemoteUrl', () => {
  it('parses an HTTPS URL', () => {
    expect(repoNameFromRemoteUrl('https://github.com/owner/repo.git')).toBe('repo')
  })

  it('parses an HTTPS URL without a trailing .git', () => {
    expect(repoNameFromRemoteUrl('https://github.com/owner/repo')).toBe('repo')
  })

  it('parses an HTTPS URL with a trailing slash', () => {
    expect(repoNameFromRemoteUrl('https://github.com/owner/repo.git/')).toBe('repo')
  })

  it('parses the SSH scp-like shorthand', () => {
    expect(repoNameFromRemoteUrl('git@github.com:owner/repo.git')).toBe('repo')
  })

  it('parses an ssh:// URL', () => {
    expect(repoNameFromRemoteUrl('ssh://git@github.com/owner/repo.git')).toBe('repo')
  })

  it('parses a POSIX local path', () => {
    expect(repoNameFromRemoteUrl('/srv/git/repo.git')).toBe('repo')
  })

  it('parses a Windows local path', () => {
    // Not scp-like: no "user@host" prefix before the drive-letter colon.
    expect(repoNameFromRemoteUrl('C:\\Users\\jl\\repos\\repo')).toBe('repo')
  })

  it('returns undefined for an empty string', () => {
    expect(repoNameFromRemoteUrl('')).toBeUndefined()
    expect(repoNameFromRemoteUrl('   ')).toBeUndefined()
  })
})

describe('parseNumstat', () => {
  it('reads added and deleted counts per path', () => {
    const m = parseNumstat('3\t1\tsrc/a.ts\n10\t0\tREADME.md\n')
    expect(m.get('src/a.ts')).toEqual({ added: 3, deleted: 1, binary: false })
    expect(m.get('README.md')).toEqual({ added: 10, deleted: 0, binary: false })
  })

  it('marks a binary file', () => {
    expect(parseNumstat('-\t-\tlogo.png').get('logo.png')).toEqual({ added: 0, deleted: 0, binary: true })
  })

  it('keys a plain rename by its new path', () => {
    expect(parseNumstat('2\t2\told.ts => new.ts').get('new.ts')).toEqual({ added: 2, deleted: 2, binary: false })
  })

  it('keys a braced rename by its new path', () => {
    const m = parseNumstat('1\t0\tsrc/{a => b}/x.ts\n0\t0\tsrc/{ => sub}/y.ts')
    expect(m.has('src/b/x.ts')).toBe(true)
    expect(m.has('src/sub/y.ts')).toBe(true)
  })

  it('tolerates CRLF and ignores blank or malformed lines', () => {
    const m = parseNumstat('1\t2\ta.ts\r\n\nwarning: something\n')
    expect([...m.keys()]).toEqual(['a.ts'])
  })
})
