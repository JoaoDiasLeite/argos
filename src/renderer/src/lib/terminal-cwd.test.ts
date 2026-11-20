import { describe, it, expect } from 'vitest'
import { cwdFromOsc7, cwdFromTitle, expandHome } from './terminal-cwd'

describe('cwdFromTitle', () => {
  it('reads the Debian and Red Hat prompt titles', () => {
    expect(cwdFromTitle('jdl@wm-devops: ~/dev/wm-project')).toBe('~/dev/wm-project')
    expect(cwdFromTitle('root@rocky9:/var/log')).toBe('/var/log')
    expect(cwdFromTitle('jdl@wm-devops: ~')).toBe('~')
    expect(cwdFromTitle('(venv) jdl@box: /srv/app')).toBe('/srv/app')
  })

  it('keeps a path with spaces or a colon in it', () => {
    expect(cwdFromTitle('jdl@box: /home/jdl/My Docs')).toBe('/home/jdl/My Docs')
    expect(cwdFromTitle('jdl@box: /tmp/a:b')).toBe('/tmp/a:b')
  })

  it('ignores titles a program set', () => {
    expect(cwdFromTitle('file.txt (~/dev) - VIM')).toBeNull()
    expect(cwdFromTitle('✳ Claude Code')).toBeNull()
    expect(cwdFromTitle('jdl@box: relative/dir')).toBeNull()
    expect(cwdFromTitle('')).toBeNull()
  })

  it('ignores a shell inside a container', () => {
    expect(cwdFromTitle('root@3f2a9c1b7d4e: /app')).toBeNull()
    expect(cwdFromTitle('root@web-01: /app')).toBe('/app')
  })
})

describe('cwdFromOsc7', () => {
  it('decodes the file URL', () => {
    expect(cwdFromOsc7('file://wm-devops/home/jdl/dev')).toBe('/home/jdl/dev')
    expect(cwdFromOsc7('file:///home/jdl/My%20Docs')).toBe('/home/jdl/My Docs')
  })

  it('rejects anything else', () => {
    expect(cwdFromOsc7('/home/jdl')).toBeNull()
    expect(cwdFromOsc7('file://host')).toBeNull()
    expect(cwdFromOsc7('file://host/%E0%A4%A')).toBeNull()
    expect(cwdFromOsc7('file://3f2a9c1b7d4e/app')).toBeNull()
  })
})

describe('expandHome', () => {
  it('makes ~ absolute when the home is known', () => {
    expect(expandHome('~', '/home/jdl')).toBe('/home/jdl')
    expect(expandHome('~/dev', '/home/jdl')).toBe('/home/jdl/dev')
    expect(expandHome('/etc', null)).toBe('/etc')
  })

  it('gives up rather than guess', () => {
    expect(expandHome('~/dev', null)).toBeNull()
    expect(expandHome('~other/dev', '/home/jdl')).toBeNull()
  })
})
