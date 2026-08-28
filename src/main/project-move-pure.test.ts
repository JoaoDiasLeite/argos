import { describe, it, expect } from 'vitest'
import {
  isInside,
  rekeyProjectKeys,
  rekeyProjectPath,
  rekeyRoomsLayout,
  sameVolume,
  verifyTarget,
  volumeOf
} from './project-move-pure'

describe('volumeOf', () => {
  it('reads a drive root from a local path', () => {
    expect(volumeOf('C:\\dev\\foo')).toBe('C:\\')
    expect(volumeOf('c:/dev/foo')).toBe('c:\\')
  })

  it('reads the host and share pair from a UNC path', () => {
    // What a WSL distro's projects look like from Windows.
    expect(volumeOf('\\\\wsl.localhost\\Ubuntu\\home\\me\\dev')).toBe('\\\\wsl.localhost\\Ubuntu')
  })

  it('treats a POSIX absolute path as living on the single root volume', () => {
    expect(volumeOf('/home/me/dev')).toBe('/')
  })

  it('names no volume for a relative or rootless path', () => {
    expect(volumeOf('dev\\foo')).toBeNull()
    expect(volumeOf('\\foo\\bar')).toBeNull()
    expect(volumeOf('')).toBeNull()
    expect(volumeOf('   ')).toBeNull()
  })
})

describe('sameVolume', () => {
  it('ignores drive-letter case, as Windows does', () => {
    expect(sameVolume('C:\\dev\\a', 'c:\\other\\b')).toBe(true)
  })

  it('separates two drives', () => {
    expect(sameVolume('C:\\dev\\a', 'D:\\dev\\a')).toBe(false)
  })

  it('treats two UNC shares on the same host as different volumes', () => {
    expect(sameVolume('\\\\wsl.localhost\\Ubuntu\\a', '\\\\wsl.localhost\\Debian\\a')).toBe(false)
  })

  it('matches two paths on the same UNC share', () => {
    expect(sameVolume('\\\\wsl.localhost\\Ubuntu\\a', '\\\\WSL.localhost\\ubuntu\\b\\c')).toBe(true)
  })

  it('refuses to call two unknown volumes a match', () => {
    // "I could not tell" must never read as "yes" to a caller about to rename.
    expect(sameVolume('dev\\a', 'dev\\b')).toBe(false)
  })
})

describe('isInside', () => {
  it('counts the folder itself as inside', () => {
    expect(isInside('C:\\dev\\foo', 'C:\\dev\\foo')).toBe(true)
  })

  it('counts a descendant at any depth', () => {
    expect(isInside('C:\\dev\\foo', 'C:\\dev\\foo\\a\\b')).toBe(true)
  })

  it('does NOT count a sibling that merely shares a prefix', () => {
    // The classic `startsWith` bug: `C:\dev\foobar` is not inside `C:\dev\foo`.
    expect(isInside('C:\\dev\\foo', 'C:\\dev\\foobar')).toBe(false)
  })

  it('ignores case and trailing separators', () => {
    expect(isInside('C:\\dev\\foo\\', 'c:/DEV/foo/a')).toBe(true)
  })

  it('is not symmetric', () => {
    expect(isInside('C:\\dev\\foo\\a', 'C:\\dev\\foo')).toBe(false)
  })
})

describe('verifyTarget', () => {
  const from = 'C:\\dev\\foo'

  it('accepts a sibling folder on the same drive, normalised', () => {
    expect(verifyTarget(from, 'C:\\dev\\bar\\')).toEqual({ ok: true, target: 'C:\\dev\\bar' })
  })

  it('accepts a target that only shares a prefix with the source', () => {
    // Same defect as the isInside test, seen from the caller: refusing this one
    // would block a perfectly ordinary rename from `foo` to `foobar`.
    expect(verifyTarget(from, 'C:\\dev\\foobar')).toEqual({ ok: true, target: 'C:\\dev\\foobar' })
  })

  it('refuses an empty or whitespace target', () => {
    expect(verifyTarget(from, '')).toEqual({ ok: false, error: 'invalid-target' })
    expect(verifyTarget(from, '   ')).toEqual({ ok: false, error: 'invalid-target' })
  })

  it('refuses a relative target', () => {
    expect(verifyTarget(from, 'bar')).toEqual({ ok: false, error: 'invalid-target' })
    expect(verifyTarget(from, '..\\bar')).toEqual({ ok: false, error: 'invalid-target' })
  })

  it('refuses a rootless path that names no volume', () => {
    // `path.isAbsolute` says yes to this one; there is still no drive to rename onto.
    expect(verifyTarget(from, '\\bar')).toEqual({ ok: false, error: 'invalid-target' })
  })

  it('refuses a filesystem root as the target', () => {
    expect(verifyTarget(from, 'C:\\')).toEqual({ ok: false, error: 'invalid-target' })
    expect(verifyTarget('\\\\wsl.localhost\\Ubuntu\\a', '\\\\wsl.localhost\\Ubuntu')).toEqual({
      ok: false,
      error: 'invalid-target'
    })
  })

  it('refuses the path it is already at, ignoring case and trailing separators', () => {
    expect(verifyTarget(from, 'c:\\DEV\\foo\\')).toEqual({ ok: false, error: 'same-path' })
  })

  it('refuses a target inside the source', () => {
    expect(verifyTarget(from, 'C:\\dev\\foo\\nested')).toEqual({
      ok: false,
      error: 'target-inside-source'
    })
  })

  it('refuses another drive rather than copying across it', () => {
    expect(verifyTarget(from, 'D:\\dev\\foo')).toEqual({ ok: false, error: 'cross-volume' })
  })

  it('refuses a UNC target when the source is local', () => {
    expect(verifyTarget(from, '\\\\wsl.localhost\\Ubuntu\\home\\me\\foo')).toEqual({
      ok: false,
      error: 'cross-volume'
    })
  })

  it('accepts a move within one WSL distro share', () => {
    expect(
      verifyTarget('\\\\wsl.localhost\\Ubuntu\\home\\me\\foo', '\\\\wsl.localhost\\Ubuntu\\home\\me\\bar')
    ).toEqual({ ok: true, target: '\\\\wsl.localhost\\Ubuntu\\home\\me\\bar' })
  })

  it('refuses a move between two WSL distros', () => {
    expect(
      verifyTarget('\\\\wsl.localhost\\Ubuntu\\home\\me\\foo', '\\\\wsl.localhost\\Debian\\home\\me\\foo')
    ).toEqual({ ok: false, error: 'cross-volume' })
  })

  it('checks same-path before containment', () => {
    // Equality satisfies isInside too; the user needs to be told it is already there,
    // not that it would swallow itself.
    expect(verifyTarget(from, from)).toEqual({ ok: false, error: 'same-path' })
  })
})

describe('rekeyProjectKeys', () => {
  it('swaps the moved project and leaves the rest alone', () => {
    expect(rekeyProjectKeys(['local:a', 'local:b'], 'local:a', 'local:z')).toEqual(['local:z', 'local:b'])
  })

  it('does not create a duplicate when the new key is already present', () => {
    expect(rekeyProjectKeys(['local:a', 'local:z'], 'local:a', 'local:z')).toEqual(['local:z'])
  })

  it('is a no-op when the project was never keyed', () => {
    expect(rekeyProjectKeys(['local:b'], 'local:a', 'local:z')).toEqual(['local:b'])
  })

  it('leaves an empty list empty', () => {
    expect(rekeyProjectKeys([], 'local:a', 'local:z')).toEqual([])
  })
})

describe('rekeyProjectPath', () => {
  it('rewrites an exact match', () => {
    expect(rekeyProjectPath('C:\\dev\\foo', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe('C:\\dev\\bar')
  })

  it('rewrites a path under the moved folder, preserving the remainder', () => {
    // A saved chat can have run in a subfolder; matching only the folder itself
    // leaves it pointing into a directory that no longer exists.
    expect(rekeyProjectPath('C:\\dev\\foo\\src\\ui', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe(
      'C:\\dev\\bar\\src\\ui'
    )
  })

  it('ignores case, as Windows does', () => {
    expect(rekeyProjectPath('c:/DEV/foo/src', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe('C:\\dev\\bar\\src')
  })

  it('leaves a sibling sharing a prefix untouched', () => {
    expect(rekeyProjectPath('C:\\dev\\foobar', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe('C:\\dev\\foobar')
  })

  it('leaves an unrelated path untouched', () => {
    expect(rekeyProjectPath('D:\\other', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe('D:\\other')
  })

  it('passes an absent path through', () => {
    expect(rekeyProjectPath(undefined, 'C:\\dev\\foo', 'C:\\dev\\bar')).toBeUndefined()
    expect(rekeyProjectPath('', 'C:\\dev\\foo', 'C:\\dev\\bar')).toBe('')
  })

  it('keeps POSIX separators when the destination is a POSIX path', () => {
    // A WSL project's stored path is POSIX on both sides of the move.
    expect(rekeyProjectPath('/home/me/foo/src', '/home/me/foo', '/home/me/bar')).toBe('/home/me/bar/src')
  })
})

describe('rekeyRoomsLayout', () => {
  it('rewrites order and names for the moved project', () => {
    expect(
      rekeyRoomsLayout(
        { order: ['C:\\dev\\foo', 'C:\\dev\\other'], names: { 'C:\\dev\\foo': 'Foo' } },
        'C:\\dev\\foo',
        'C:\\dev\\bar'
      )
    ).toEqual({ order: ['C:\\dev\\bar', 'C:\\dev\\other'], names: { 'C:\\dev\\bar': 'Foo' } })
  })

  it('leaves non-path room keys alone', () => {
    expect(
      rekeyRoomsLayout({ order: ['__unassigned__', 'C:\\dev\\foo'], names: {} }, 'C:\\dev\\foo', 'C:\\dev\\bar')
    ).toEqual({ order: ['__unassigned__', 'C:\\dev\\bar'], names: {} })
  })

  it('rewrites a nested project, which moved with its parent', () => {
    expect(
      rekeyRoomsLayout({ order: ['C:\\dev\\foo\\sub'], names: {} }, 'C:\\dev\\foo', 'C:\\dev\\bar')
    ).toEqual({ order: ['C:\\dev\\bar\\sub'], names: {} })
  })

  it('does not duplicate a room the destination already had', () => {
    expect(
      rekeyRoomsLayout({ order: ['C:\\dev\\foo', 'C:\\dev\\bar'], names: {} }, 'C:\\dev\\foo', 'C:\\dev\\bar')
    ).toEqual({ order: ['C:\\dev\\bar'], names: {} })
  })

  it('leaves an untouched layout equal to what it was', () => {
    const layout = { order: ['C:\\dev\\other'], names: { 'C:\\dev\\other': 'Other' } }
    expect(rekeyRoomsLayout(layout, 'C:\\dev\\foo', 'C:\\dev\\bar')).toEqual(layout)
  })
})
