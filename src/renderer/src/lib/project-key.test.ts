import { describe, it, expect } from 'vitest'
import {
  buildPosixDistroMap,
  canonicalProjectPath,
  legacyProjectKey,
  parseWslUnc,
  projectKey
} from './project-key'

describe('projectKey', () => {
  it('treats backslash and forward slash separators as the same path', () => {
    expect(projectKey('C:\\dev\\claude-gui')).toBe(projectKey('C:/dev/claude-gui'))
  })

  it('folds case, so a folder recorded with different casing collapses to one key', () => {
    expect(projectKey('C:\\dev\\claude-gui')).toBe(projectKey('C:\\dev\\Claude-GUI'))
  })

  it('strips a trailing separator', () => {
    expect(projectKey('C:\\dev\\claude-gui\\')).toBe(projectKey('C:\\dev\\claude-gui'))
    expect(projectKey('/home/me/proj/')).toBe(projectKey('/home/me/proj'))
  })

  it('returns an empty string for an empty path', () => {
    expect(projectKey('')).toBe('')
  })
})

describe('projectKey across the ways one WSL folder is addressed', () => {
  const UNC = '\\\\wsl.localhost\\Ubuntu-DevOps\\home\\jdl\\dev\\wm-project'
  const POSIX = '/home/jdl/dev/wm-project'
  const ctx = { driveMap: { 'z:': 'Ubuntu-DevOps' } }

  it('folds a POSIX path onto the UNC one when the chat names its distro', () => {
    expect(projectKey(POSIX, 'Ubuntu-DevOps')).toBe(projectKey(UNC))
  })

  it('folds a drive letter mapped to that distro onto the UNC one', () => {
    expect(projectKey('Z:\\home\\jdl\\dev\\wm-project', undefined, ctx)).toBe(projectKey(UNC))
  })

  it('folds the older \\\\wsl$ prefix onto \\\\wsl.localhost', () => {
    expect(projectKey('\\\\wsl$\\Ubuntu-DevOps\\home\\jdl\\dev\\wm-project')).toBe(projectKey(UNC))
  })

  it('folds a distro-less POSIX path in on the evidence of a chat that names one', () => {
    const posixDistros = buildPosixDistroMap([
      { projectPath: POSIX, wslDistro: 'Ubuntu-DevOps' },
      { projectPath: POSIX }
    ])
    expect(projectKey(POSIX, undefined, { posixDistros })).toBe(projectKey(UNC))
  })

  it('keeps the same path in two different distros apart', () => {
    expect(projectKey(POSIX, 'Ubuntu')).not.toBe(projectKey(POSIX, 'Ubuntu-DevOps'))
  })

  it('leaves an unmapped drive letter and an unattributable POSIX path alone', () => {
    expect(projectKey('Y:\\home\\jdl\\dev\\wm-project', undefined, ctx)).toBe(
      'y:/home/jdl/dev/wm-project'
    )
    expect(projectKey(POSIX)).toBe(POSIX)
  })

  it('groups all four spellings of one real folder together', () => {
    const sessions = [
      { projectPath: POSIX, wslDistro: 'Ubuntu-DevOps' },
      { projectPath: POSIX },
      { projectPath: UNC, wslDistro: 'Ubuntu-DevOps' },
      { projectPath: 'Z:\\home\\jdl\\dev\\wm-project' }
    ]
    const full = { ...ctx, posixDistros: buildPosixDistroMap(sessions) }
    const keys = new Set(sessions.map((s) => projectKey(s.projectPath, s.wslDistro, full)))
    expect(keys.size).toBe(1)
  })
})

describe('projectKey for a Windows drive mounted inside a distro', () => {
  it('puts /mnt/c with the Windows chats in that same folder, not under the distro', () => {
    expect(projectKey('/mnt/c/dev/proj', 'Ubuntu')).toBe(projectKey('C:\\dev\\proj'))
  })

  it('is the same folder whichever distro it was mounted in', () => {
    expect(projectKey('/mnt/c/dev/proj', 'Ubuntu')).toBe(projectKey('/mnt/c/dev/proj', 'Debian'))
  })

  it('handles the drive root, and folds its case', () => {
    expect(canonicalProjectPath('/mnt/c', 'Ubuntu')).toBe('C:\\')
    expect(projectKey('/mnt/C/dev/proj', 'Ubuntu')).toBe(projectKey('c:/dev/proj'))
  })

  it('leaves a real folder that merely starts with /mnt alone', () => {
    expect(canonicalProjectPath('/mnt/cdrom/proj', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\mnt\\cdrom\\proj'
    )
    expect(canonicalProjectPath('/mnt/data/proj', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\mnt\\data\\proj'
    )
  })

  it('leaves /mnt/c on a machine that is not a distro exactly as it was', () => {
    // An SSH host's own mount point. Nothing here knows it to be WSL, so nothing here
    // is entitled to call it a Windows drive.
    expect(canonicalProjectPath('/mnt/c/dev/proj')).toBe('/mnt/c/dev/proj')
  })
})

describe('projectKey for the Git Bash spelling of a Windows path', () => {
  it('groups /c/Users/me/proj with the chats that call it C:\\Users\\me\\proj', () => {
    expect(projectKey('/c/Users/me/proj')).toBe(projectKey('C:\\Users\\me\\proj'))
  })

  it('needs no distro, and is unchanged by one', () => {
    expect(projectKey('/c/Users/me/proj', 'Ubuntu')).toBe(projectKey('/c/Users/me/proj'))
  })

  it('covers /c/Windows and any drive letter', () => {
    expect(canonicalProjectPath('/c/Windows/Temp')).toBe('C:\\Windows\\Temp')
    expect(canonicalProjectPath('/d/Users/me')).toBe('D:\\Users\\me')
  })

  it('leaves a single-letter directory alone when nothing anchors it to Windows', () => {
    // `/c/dev` is a perfectly ordinary path on a Linux box, so it stays a Linux path.
    expect(canonicalProjectPath('/c/dev/proj')).toBe('/c/dev/proj')
    expect(canonicalProjectPath('/c/dev/proj', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\c\\dev\\proj'
    )
  })

  it('does not mistake a longer first segment for a drive letter', () => {
    expect(canonicalProjectPath('/opt/Users/me')).toBe('/opt/Users/me')
  })
})

describe('canonicalProjectPath', () => {
  it('gives a group a Windows-reachable path, so a new chat in it has a real cwd', () => {
    expect(canonicalProjectPath('/home/jdl/dev/wm-project', 'Ubuntu-DevOps')).toBe(
      '\\\\wsl.localhost\\Ubuntu-DevOps\\home\\jdl\\dev\\wm-project'
    )
  })

  it('leaves an ordinary Windows path exactly as it was', () => {
    expect(canonicalProjectPath('C:\\dev\\claude-gui')).toBe('C:\\dev\\claude-gui')
  })
})

describe('buildPosixDistroMap', () => {
  it('drops a path two distros both claim, rather than guessing between them', () => {
    const map = buildPosixDistroMap([
      { projectPath: '/home/me/proj', wslDistro: 'Ubuntu' },
      { projectPath: '/home/me/proj', wslDistro: 'Debian' }
    ])
    expect(map.has('/home/me/proj')).toBe(false)
  })

  it('ignores sessions with no distro, and Windows paths', () => {
    const map = buildPosixDistroMap([
      { projectPath: '/home/me/proj' },
      { projectPath: 'C:\\dev\\x', wslDistro: 'Ubuntu' }
    ])
    expect(map.size).toBe(0)
  })
})

describe('legacyProjectKey', () => {
  it('is the pre-WSL-folding key, so a name filed under it can still be found', () => {
    expect(legacyProjectKey('/home/jdl/dev/wm-project')).toBe('/home/jdl/dev/wm-project')
    expect(legacyProjectKey('C:\\dev\\Claude-GUI\\')).toBe('c:/dev/claude-gui')
  })
})

describe('parseWslUnc', () => {
  it('reads the distro and the Linux path out of a WSL share path', () => {
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu-DevOps\\home\\jdl\\dev\\wm-project')).toEqual({
      distro: 'Ubuntu-DevOps',
      posixPath: '/home/jdl/dev/wm-project'
    })
  })

  it('reads the older \\\\wsl$ spelling too', () => {
    expect(parseWslUnc('\\\\wsl$\\Ubuntu\\home\\me\\proj')).toEqual({
      distro: 'Ubuntu',
      posixPath: '/home/me/proj'
    })
  })

  it('accepts the already-slashed spelling, which is how a saved session may hold it', () => {
    expect(parseWslUnc('//wsl.localhost/Ubuntu/home/me/proj')?.distro).toBe('Ubuntu')
  })

  it('gives the distro root when the path is the share itself', () => {
    expect(parseWslUnc('\\\\wsl.localhost\\Ubuntu')).toEqual({ distro: 'Ubuntu', posixPath: '/' })
  })

  it('is null for every other kind of path, so nothing else is mistaken for WSL', () => {
    expect(parseWslUnc('C:\\dev\\proj')).toBeNull()
    expect(parseWslUnc('/home/me/proj')).toBeNull()
    // A plain Windows share, not a distro.
    expect(parseWslUnc('\\\\fileserver\\share\\proj')).toBeNull()
    expect(parseWslUnc('')).toBeNull()
  })
})
