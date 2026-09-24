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

describe('terminalPathsText', () => {
  it('joins what can be reached, with a trailing space', () => {
    expect(terminalPathsText(['C:\\a', 'C:\\b c'], {})).toBe('C:\\a "C:\\b c" ')
    expect(terminalPathsText(['C:\\a'], { remoteHostId: 'h1' })).toBe('')
  })
})
