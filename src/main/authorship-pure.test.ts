import { describe, it, expect } from 'vitest'
import { attribute, authoredPath, canonPath, toRepoRelative } from './authorship-pure'

describe('authoredPath', () => {
  it('takes the target of the four writing tools', () => {
    expect(authoredPath('Edit', { file_path: 'C:\\repo\\a.ts' })).toBe('C:\\repo\\a.ts')
    expect(authoredPath('Write', { file_path: '/home/me/a.ts' })).toBe('/home/me/a.ts')
    expect(authoredPath('MultiEdit', { file_path: '/home/me/a.ts' })).toBe('/home/me/a.ts')
    expect(authoredPath('NotebookEdit', { notebook_path: '/home/me/n.ipynb' })).toBe(
      '/home/me/n.ipynb'
    )
  })

  it('ignores tools that write nothing nameable', () => {
    expect(authoredPath('Read', { file_path: '/home/me/a.ts' })).toBeNull()
    expect(authoredPath('Bash', { command: 'sed -i s/a/b/ a.ts' })).toBeNull()
  })

  it('survives a call with no usable input', () => {
    expect(authoredPath('Edit', null)).toBeNull()
    expect(authoredPath('Edit', {})).toBeNull()
    expect(authoredPath('Edit', { file_path: '   ' })).toBeNull()
  })
})

describe('canonPath', () => {
  it('folds the four spellings of one WSL file onto each other', () => {
    const want = '/home/me/repo/src/a.ts'
    expect(canonPath('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo\\src\\a.ts')).toBe(want)
    expect(canonPath('\\\\wsl$\\Ubuntu\\home\\me\\repo\\src\\a.ts')).toBe(want)
    expect(canonPath('//wsl.localhost/Ubuntu/home/me/repo/src/a.ts')).toBe(want)
    expect(canonPath('/home/me/repo/src/a.ts')).toBe(want)
  })

  it('folds a Windows checkout reached through the drive mount', () => {
    expect(canonPath('C:\\repo\\src\\a.ts')).toBe('c:/repo/src/a.ts')
    expect(canonPath('/mnt/c/repo/src/a.ts')).toBe('c:/repo/src/a.ts')
  })

  it('drops trailing separators without eating the root', () => {
    expect(canonPath('C:\\repo\\')).toBe('c:/repo')
    expect(canonPath('/')).toBe('/')
    expect(canonPath('')).toBe('')
  })
})

describe('toRepoRelative', () => {
  it('makes a status-shaped path out of an absolute one', () => {
    expect(toRepoRelative('C:\\repo\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
  })

  it('matches a distro path against the share the repo was opened through', () => {
    expect(
      toRepoRelative('/home/me/repo/src/a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')
    ).toBe('src/a.ts')
  })

  it('ignores the case a Windows path is written in', () => {
    expect(toRepoRelative('c:\\REPO\\src\\A.ts', 'C:\\repo')).toBe('src/A.ts')
  })

  it('maps a worktree back onto the repo it was cut from', () => {
    expect(toRepoRelative('C:\\repo.worktrees\\1a2b3c4d\\src\\a.ts', 'C:\\repo')).toBe('src/a.ts')
    expect(toRepoRelative('C:\\elsewhere\\wt\\src\\a.ts', 'C:\\repo', 'C:\\elsewhere\\wt')).toBe(
      'src/a.ts'
    )
  })

  it('drops a path outside the repo rather than guessing', () => {
    expect(toRepoRelative('C:\\other\\a.ts', 'C:\\repo')).toBeNull()
    // A sibling whose name merely starts the same is not inside it.
    expect(toRepoRelative('C:\\repo-two\\a.ts', 'C:\\repo')).toBeNull()
    // The root itself is not a file in the repo.
    expect(toRepoRelative('C:\\repo', 'C:\\repo')).toBeNull()
  })
})

describe('attribute', () => {
  const status = ['src/a.ts', 'src/b.ts', 'src/c.ts']
  const ledgers = [
    { sessionId: 's1', name: 'Mine', paths: ['src/a.ts'], updatedAt: 10 },
    { sessionId: 's2', name: 'Theirs', paths: ['src/b.ts'], updatedAt: 20 }
  ]

  it('splits the tree into this chat, other chats, and nobody', () => {
    const r = attribute(status, ledgers, 's1')
    expect(r.mine).toEqual(['src/a.ts'])
    expect(r.others).toEqual([{ path: 'src/b.ts', sessionId: 's2', name: 'Theirs' }])
    expect(r.unattributed).toEqual(['src/c.ts'])
  })

  it('gives the active chat a file two chats wrote', () => {
    const shared = [
      { sessionId: 's1', name: 'Mine', paths: ['src/b.ts'], updatedAt: 10 },
      ...ledgers.slice(1)
    ]
    expect(attribute(['src/b.ts'], shared, 's1').mine).toEqual(['src/b.ts'])
  })

  it('names the most recent writer among the others', () => {
    const both = [
      { sessionId: 's2', name: 'Older', paths: ['src/b.ts'], updatedAt: 5 },
      { sessionId: 's3', name: 'Newer', paths: ['src/b.ts'], updatedAt: 50 }
    ]
    expect(attribute(['src/b.ts'], both, 's1').others[0].name).toBe('Newer')
  })

  it('attributes nothing with no active chat, rather than everything', () => {
    const r = attribute(status, ledgers)
    expect(r.mine).toEqual([])
    expect(r.others.map((o) => o.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(r.unattributed).toEqual(['src/c.ts'])
  })

  it('keeps the order git listed the files in', () => {
    const one = [{ sessionId: 's1', name: 'Mine', paths: status, updatedAt: 1 }]
    expect(attribute(status, one, 's1').mine).toEqual(status)
  })
})
