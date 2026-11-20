import { describe, it, expect } from 'vitest'
import { parseNumstat, parsePorcelainZ } from './git-pure'
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

describe('parsePorcelainZ', () => {
  const z = (...f: string[]) => f.join('\0') + '\0'

  it('parses plain modified, added and deleted entries', () => {
    expect(parsePorcelainZ(z(' M src/a.ts', 'A  b.ts', ' D c.ts'))).toEqual([
      { index: ' ', worktree: 'M', path: 'src/a.ts' },
      { index: 'A', worktree: ' ', path: 'b.ts' },
      { index: ' ', worktree: 'D', path: 'c.ts' }
    ])
  })

  it('keeps spaces, accents and quotes in names as they are', () => {
    const e = parsePorcelainZ(z('?? my file.txt', '?? café.txt', '?? say "hi".txt'))
    expect(e.map((x) => x.path)).toEqual(['my file.txt', 'café.txt', 'say "hi".txt'])
  })

  it('reads a rename as destination plus origin', () => {
    expect(parsePorcelainZ(z('R  new name.ts', 'old name.ts', ' M x.ts'))).toEqual([
      { index: 'R', worktree: ' ', path: 'new name.ts', origPath: 'old name.ts' },
      { index: ' ', worktree: 'M', path: 'x.ts' }
    ])
  })

  it('reads a copy and a rename with an unstaged edit', () => {
    const e = parsePorcelainZ(z('C  copy.ts', 'orig.ts', 'RM moved.ts', 'before.ts'))
    expect(e[0]).toMatchObject({ path: 'copy.ts', origPath: 'orig.ts' })
    expect(e[1]).toMatchObject({ index: 'R', worktree: 'M', path: 'moved.ts', origPath: 'before.ts' })
  })

  it('does not split a name that contains " -> "', () => {
    expect(parsePorcelainZ(z('?? a -> b.txt'))).toEqual([{ index: '?', worktree: '?', path: 'a -> b.txt' }])
  })

  it('passes conflict states through', () => {
    const e = parsePorcelainZ(z('UU both.ts', 'AA added.ts', 'DU gone.ts'))
    expect(e.map((x) => x.index + x.worktree)).toEqual(['UU', 'AA', 'DU'])
  })

  it('returns [] for empty output', () => {
    expect(parsePorcelainZ('')).toEqual([])
  })
})

describe('parseNumstat', () => {
  const z = (...f: string[]) => f.join('\0') + '\0'

  it('reads added and deleted counts per path', () => {
    const m = parseNumstat(z('3\t1\tsrc/a.ts', '10\t0\tREADME.md'))
    expect(m.get('src/a.ts')).toEqual({ added: 3, deleted: 1, binary: false })
    expect(m.get('README.md')).toEqual({ added: 10, deleted: 0, binary: false })
  })

  it('marks binaries, which print "-" for both counts', () => {
    expect(parseNumstat(z('-\t-\tlogo.png')).get('logo.png')).toEqual({ added: 0, deleted: 0, binary: true })
  })

  it('keys a rename by its new path', () => {
    const m = parseNumstat(z('2\t2\t', 'old name.ts', 'new name.ts', '1\t0\tafter.ts'))
    expect(m.get('new name.ts')).toEqual({ added: 2, deleted: 2, binary: false })
    expect(m.get('after.ts')).toEqual({ added: 1, deleted: 0, binary: false })
    expect(m.size).toBe(2)
  })

  it('keeps accents and spaces, and handles empty output', () => {
    expect(parseNumstat(z('1\t1\tcafé au lait.txt')).has('café au lait.txt')).toBe(true)
    expect(parseNumstat('').size).toBe(0)
  })
})
