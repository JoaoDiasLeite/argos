import { describe, it, expect } from 'vitest'
import { terminalPathFor, terminalPathsText } from './terminal-file-paths'

describe('terminalPathFor', () => {
  it('types a local path as is, quoting one with a space', () => {
    expect(terminalPathFor('C:\\dev\\a.png', {})).toBe('C:\\dev\\a.png')
    expect(terminalPathFor('C:\\my dev\\a.png', {})).toBe('"C:\\my dev\\a.png"')
  })

  it('names a Windows drive through its WSL mount', () => {
    expect(terminalPathFor('C:\\dev\\a.png', { wslDistro: 'Ubuntu' })).toBe('/mnt/c/dev/a.png')
    expect(terminalPathFor('D:\\my dev\\it\'s.txt', { wslDistro: 'Ubuntu' })).toBe(
      "'/mnt/d/my dev/it'\\''s.txt'"
    )
  })

  it("maps the distro's own share onto its root", () => {
    expect(terminalPathFor('\\\\wsl.localhost\\Ubuntu\\home\\me\\x.ts', { wslDistro: 'ubuntu' })).toBe(
      '/home/me/x.ts'
    )
    expect(terminalPathFor('\\\\wsl$\\Ubuntu\\tmp', { wslDistro: 'Ubuntu' })).toBe('/tmp')
  })

  it("refuses another distro's files, other shares, and anything over SSH", () => {
    expect(terminalPathFor('\\\\wsl.localhost\\Debian\\x', { wslDistro: 'Ubuntu' })).toBeNull()
    expect(terminalPathFor('\\\\server\\share\\x', { wslDistro: 'Ubuntu' })).toBeNull()
    expect(terminalPathFor('C:\\dev\\a.png', { remoteHostId: 'h1' })).toBeNull()
  })
})

describe("terminalPathFor with the distro's answer", () => {
  const env = { wslDistro: 'Ubuntu' }

  it('uses what the distro says, wherever it mounts its drives', () => {
    expect(terminalPathFor('C:\\dev\\a b.png', env, '/c/dev/a b.png')).toBe("'/c/dev/a b.png'")
  })

  it('types nothing for a path the distro cannot reach', () => {
    expect(terminalPathFor('D:\\x', env, null)).toBeNull()
  })

  it("never asks about another distro's share", () => {
    expect(terminalPathFor('\\\\wsl.localhost\\Debian\\home', env, '-DevOps/home')).toBeNull()
  })
})

describe('terminalPathsText', () => {
  it('pairs each path with its answer', () => {
    expect(terminalPathsText(['C:\\a', 'D:\\b'], { wslDistro: 'Ubuntu' }, ['/c/a', null])).toBe('/c/a ')
  })

  it('joins what can be reached, with a trailing space', () => {
    expect(terminalPathsText(['C:\\a', 'C:\\b c'], {})).toBe('C:\\a "C:\\b c" ')
    expect(terminalPathsText(['C:\\a'], { remoteHostId: 'h1' })).toBe('')
  })
})
