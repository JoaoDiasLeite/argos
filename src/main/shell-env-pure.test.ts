import { describe, expect, it } from 'vitest'
import {
  ENV_MARKER,
  appendPathDirs,
  darwinFallbackDirs,
  parseEnvDump,
  prependPathDirs,
  shellEnvCommand,
  shellEnvUpdates
} from './shell-env-pure'

describe('shellEnvCommand', () => {
  it('prints the marker around env -0 with absolute paths only', () => {
    const cmd = shellEnvCommand()
    expect(cmd).toContain('/usr/bin/env -0')
    expect(cmd.split(ENV_MARKER).length).toBe(3)
  })
})

describe('parseEnvDump', () => {
  const dump = (entries: string[]): string => `${ENV_MARKER}${entries.join('\0')}\0${ENV_MARKER}`

  it('skips rc-file junk before and after the markers', () => {
    const out = `Welcome!\nlast login...\n${dump(['PATH=/opt/homebrew/bin:/usr/bin', 'HOME=/Users/x'])}trailing`
    expect(parseEnvDump(out)).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/Users/x' })
  })

  it('keeps newlines and = inside values', () => {
    expect(parseEnvDump(dump(['A=1\n2', 'B=x=y']))).toEqual({ A: '1\n2', B: 'x=y' })
  })

  it('drops entries that are not NAME=value', () => {
    expect(parseEnvDump(dump(['noequals', '=x', 'BAD NAME=1', 'OK=1']))).toEqual({ OK: '1' })
  })

  it('returns null without both markers or without entries', () => {
    expect(parseEnvDump('')).toBeNull()
    expect(parseEnvDump(`${ENV_MARKER}PATH=/x`)).toBeNull()
    expect(parseEnvDump(`${ENV_MARKER}${ENV_MARKER}`)).toBeNull()
    // `env -0` unsupported: env printed its usage to stderr, nothing between the markers.
    expect(parseEnvDump(`${ENV_MARKER}\n${ENV_MARKER}`)).toBeNull()
  })
})

describe('PATH merging', () => {
  it('prepends the shell dirs the current PATH lacks, in shell order', () => {
    expect(prependPathDirs('/usr/bin:/bin', '/opt/homebrew/bin:/usr/bin:/Users/x/.local/bin:/bin')).toBe(
      '/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin'
    )
  })

  it('is idempotent', () => {
    const once = prependPathDirs('/usr/bin', '/a:/b')
    expect(prependPathDirs(once, '/a:/b')).toBe(once)
  })

  it('appends fallbacks without duplicates', () => {
    expect(appendPathDirs('/usr/bin:/opt/homebrew/bin', ['/opt/homebrew/bin', '/usr/local/bin'])).toBe(
      '/usr/bin:/opt/homebrew/bin:/usr/local/bin'
    )
    expect(appendPathDirs(undefined, ['/a'])).toBe('/a')
  })

  it('lists Homebrew, /usr/local, ~/.local/bin and ~/.npm-global/bin', () => {
    expect(darwinFallbackDirs('/Users/x')).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/Users/x/.local/bin',
      '/Users/x/.npm-global/bin'
    ])
  })
})

describe('shellEnvUpdates', () => {
  it('merges PATH and takes SSH_AUTH_SOCK only when unset', () => {
    expect(
      shellEnvUpdates({ PATH: '/usr/bin' }, { PATH: '/opt/homebrew/bin:/usr/bin', SSH_AUTH_SOCK: '/tmp/agent', FOO: '1' })
    ).toEqual({ PATH: '/opt/homebrew/bin:/usr/bin', SSH_AUTH_SOCK: '/tmp/agent' })
    expect(shellEnvUpdates({ PATH: '/usr/bin', SSH_AUTH_SOCK: '/launchd' }, { SSH_AUTH_SOCK: '/tmp/agent' })).toEqual({})
  })

  it('changes nothing when the PATH already has every dir', () => {
    expect(shellEnvUpdates({ PATH: '/a:/b' }, { PATH: '/b:/a' })).toEqual({})
  })
})
