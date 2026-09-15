import { describe, it, expect } from 'vitest'
import { projectDisplayName, projectDisplayNames } from './project-name'

describe('projectDisplayName', () => {
  it('falls back to the basename when there is nothing else', () => {
    expect(projectDisplayName('k', 'C:\\dev\\claude-gui')).toBe('claude-gui')
  })

  it('prefers the repo remote name over the folder basename', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', {
        repos: { k: { remote: 'argos', toplevel: 'claude-gui-toplevel' } }
      })
    ).toBe('argos')
  })

  it('falls back to the repo toplevel name when there is no remote', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', {
        repos: { k: { toplevel: 'argos-toplevel' } }
      })
    ).toBe('argos-toplevel')
  })

  it('a custom name wins over the repo name', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', {
        custom: { k: 'My Project' },
        repos: { k: { remote: 'argos' } }
      })
    ).toBe('My Project')
  })

  it('a custom name wins even with no repo at all', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', { custom: { k: 'My Project' } })
    ).toBe('My Project')
  })

  it('treats a whitespace-only custom name as unset', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', {
        custom: { k: '   ' },
        repos: { k: { remote: 'argos' } }
      })
    ).toBe('argos')

    expect(projectDisplayName('k', 'C:\\dev\\claude-gui', { custom: { k: '   ' } })).toBe(
      'claude-gui'
    )
  })

  it('handles both Windows and POSIX separators in the basename fallback', () => {
    expect(projectDisplayName('k', 'C:\\dev\\claude-gui\\')).toBe('claude-gui')
    expect(projectDisplayName('k', '/home/me/proj/')).toBe('proj')
    expect(projectDisplayName('k', '/home/me/proj')).toBe('proj')
  })

  it('returns the raw path instead of an empty string when there is no basename', () => {
    expect(projectDisplayName('k', '')).toBe('')
    expect(projectDisplayName('k', '///')).toBe('///')
  })

  it('is unaffected by sources for a different key', () => {
    expect(
      projectDisplayName('k', 'C:\\dev\\claude-gui', {
        custom: { other: 'Not This' },
        repos: { other: { remote: 'not-this-either' } }
      })
    ).toBe('claude-gui')
  })
})

describe('projectDisplayNames', () => {
  it('leaves distinct names alone', () => {
    const names = projectDisplayNames([
      { key: 'k1', path: 'C:\\dev\\api' },
      { key: 'k2', path: 'C:\\dev\\web' }
    ])
    expect(names.get('k1')).toBe('api')
    expect(names.get('k2')).toBe('web')
  })

  it('disambiguates two different keys that resolve to the same name with their parent folder', () => {
    const names = projectDisplayNames([
      { key: 'k1', path: 'C:\\wm\\api' },
      { key: 'k2', path: 'C:\\other\\api' }
    ])
    expect(names.get('k1')).toBe('wm/api')
    expect(names.get('k2')).toBe('other/api')
  })

  it('never collides two spellings of the same key with themselves', () => {
    const names = projectDisplayNames([
      { key: 'k1', path: 'C:\\wm\\api' },
      { key: 'k1', path: 'C:/wm/api/' }
    ])
    expect(names.size).toBe(1)
    expect(names.get('k1')).toBe('api')
  })

  it('leaves a collision between two custom names alone — the user is responsible for it', () => {
    const names = projectDisplayNames(
      [
        { key: 'k1', path: 'C:\\wm\\proj-a' },
        { key: 'k2', path: 'C:\\other\\proj-b' }
      ],
      { custom: { k1: 'argos', k2: 'argos' } }
    )
    expect(names.get('k1')).toBe('argos')
    expect(names.get('k2')).toBe('argos')
  })

  it('disambiguates a derived name that collides with a custom one, leaving the custom name untouched', () => {
    const names = projectDisplayNames(
      [
        { key: 'k1', path: 'C:\\wm\\argos' },
        { key: 'k2', path: 'C:\\other\\argos' }
      ],
      { custom: { k1: 'argos' } }
    )
    expect(names.get('k1')).toBe('argos')
    expect(names.get('k2')).toBe('other/argos')
  })

  it('returns what it has, without looping, when there is no parent folder to disambiguate with', () => {
    const names = projectDisplayNames([
      { key: 'k1', path: 'api' },
      { key: 'k2', path: 'api' }
    ])
    expect(names.get('k1')).toBe('api')
    expect(names.get('k2')).toBe('api')
  })

  it('keeps the plain name for two different keys that share an identical path', () => {
    const names = projectDisplayNames([
      { key: 'k1', path: 'C:\\dev\\jdl' },
      { key: 'k2', path: 'C:\\dev\\jdl' }
    ])
    expect(names.get('k1')).toBe('jdl')
    expect(names.get('k2')).toBe('jdl')
  })
})

describe('projectDisplayNames — disambiguating past the immediate parent', () => {
  it('still prefixes with just the parent when that already tells them apart', () => {
    const names = projectDisplayNames([
      { key: 'a', path: '/src/wm/api' },
      { key: 'b', path: '/src/other/api' }
    ])
    expect(names.get('a')).toBe('wm/api')
    expect(names.get('b')).toBe('other/api')
  })

  it('climbs past a parent that settles nothing to find one that does', () => {
    // Three `jdl` checkouts: two WSL distros and one local Windows folder. `a` and `b`
    // share a `home` parent, so theirs settles nothing and the distro above it separates
    // them; `c` needs no climbing, its own parent is already unlike the others. Each
    // entry takes the closest level that works for it, not one imposed on the group.
    const names = projectDisplayNames([
      { key: 'a', path: '\\\\wsl.localhost\\Ubuntu\\home\\jdl' },
      { key: 'b', path: '\\\\wsl.localhost\\Ubuntu-DevOps\\home\\jdl' },
      { key: 'c', path: 'C:\\Users\\Joao\\jdl' }
    ])
    expect(names.get('a')).toBe('Ubuntu/jdl')
    expect(names.get('b')).toBe('Ubuntu-DevOps/jdl')
    expect(names.get('c')).toBe('Joao/jdl')
  })

  it('names the entries it can, even when a sibling cannot be named', () => {
    // The real case: three `jdl` groups, each a different WSL distro, and only the
    // canonical path carries the distro — `c` was recorded as a bare POSIX path and runs
    // out of segments before any distinguishing level. `a` and `b` are still named,
    // because all three staying ambiguous on account of one that cannot be helped is
    // worse than two of the three reading clearly.
    const names = projectDisplayNames([
      { key: 'a', path: '//wsl.localhost/Ubuntu/home/jdl' },
      { key: 'b', path: '//wsl.localhost/Ubuntu-DevOps/home/jdl' },
      { key: 'c', path: '/home/jdl' }
    ])
    expect(names.get('a')).toBe('Ubuntu/jdl')
    expect(names.get('b')).toBe('Ubuntu-DevOps/jdl')
    expect(names.get('c')).toBe('jdl')
  })
})
