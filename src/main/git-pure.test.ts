import { describe, it, expect } from 'vitest'
import { repoNameFromRemoteUrl } from './git'

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
