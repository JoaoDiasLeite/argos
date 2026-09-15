import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { migrateUserDataDir, resyncUserDataDir, rewritePaths, MARKER } from './migrate-userdata'

let tmp: string
let oldDir: string
let newDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-test-'))
  oldDir = path.join(tmp, 'claude-gui')
  newDir = path.join(tmp, 'argos')
  fs.mkdirSync(oldDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('rewritePaths', () => {
  it('rewrites only strings that start with the old root', () => {
    const out = rewritePaths(
      {
        configDir: 'C:\\data\\claude-gui\\cc-accounts\\acc_1',
        // A project that merely shares the old app's name must survive untouched.
        projectPath: 'C:\\code\\Projetos\\claude-gui',
        nested: [{ dir: 'C:\\data\\claude-gui\\sessions' }],
        other: null,
        count: 3
      },
      'C:\\data\\claude-gui',
      'C:\\data\\argos'
    )
    expect(out).toEqual({
      configDir: 'C:\\data\\argos\\cc-accounts\\acc_1',
      projectPath: 'C:\\code\\Projetos\\claude-gui',
      nested: [{ dir: 'C:\\data\\argos\\sessions' }],
      other: null,
      count: 3
    })
  })
})

describe('migrateUserDataDir', () => {
  it('copies data across and leaves the source in place', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"a":1}')
    fs.mkdirSync(path.join(oldDir, 'sessions'))
    fs.writeFileSync(path.join(oldDir, 'sessions', 's1.json'), '{"id":"s1"}')

    const result = migrateUserDataDir(oldDir, newDir)

    expect(result.migrated).toBe(true)
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"a":1}')
    expect(fs.existsSync(path.join(newDir, 'sessions', 's1.json'))).toBe(true)
    // A copy, not a move.
    expect(fs.existsSync(path.join(oldDir, 'config.json'))).toBe(true)
  })

  it('rewrites absolute paths that pointed into the old directory', () => {
    fs.writeFileSync(
      path.join(oldDir, 'accounts.json'),
      JSON.stringify({ accounts: [{ configDir: path.join(oldDir, 'cc-accounts', 'acc_1') }] })
    )

    expect(migrateUserDataDir(oldDir, newDir).migrated).toBe(true)

    const moved = JSON.parse(fs.readFileSync(path.join(newDir, 'accounts.json'), 'utf8'))
    expect(moved.accounts[0].configDir).toBe(path.join(newDir, 'cc-accounts', 'acc_1'))
  })

  it('skips Chromium state and the single-instance lockfile', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{}')
    fs.writeFileSync(path.join(oldDir, 'lockfile'), 'x')
    fs.mkdirSync(path.join(oldDir, 'Cache'))
    fs.writeFileSync(path.join(oldDir, 'Cache', 'blob'), 'x')

    migrateUserDataDir(oldDir, newDir)

    expect(fs.existsSync(path.join(newDir, 'lockfile'))).toBe(false)
    expect(fs.existsSync(path.join(newDir, 'Cache'))).toBe(false)
  })

  it('is idempotent — the marker stops a second run', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"v":1}')
    expect(migrateUserDataDir(oldDir, newDir).migrated).toBe(true)
    expect(fs.existsSync(path.join(newDir, MARKER))).toBe(true)

    // Change the source; a second run must not re-import over the user's newer data.
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"v":2}')
    expect(migrateUserDataDir(oldDir, newDir).migrated).toBe(false)
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"v":1}')
  })

  it('never clobbers a new directory that is already in use', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"from":"old"}')
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(newDir, 'config.json'), '{"from":"new"}')

    expect(migrateUserDataDir(oldDir, newDir).migrated).toBe(false)
    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"from":"new"}')
  })

  it('does nothing when there is no old directory or the paths match', () => {
    expect(migrateUserDataDir(path.join(tmp, 'absent'), newDir).migrated).toBe(false)
    expect(migrateUserDataDir(oldDir, oldDir).migrated).toBe(false)
  })

  it('leaves a malformed json file exactly as copied', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{}')
    fs.writeFileSync(path.join(oldDir, 'broken.json'), `{ not json ${oldDir}`)

    expect(migrateUserDataDir(oldDir, newDir).migrated).toBe(true)
    expect(fs.readFileSync(path.join(newDir, 'broken.json'), 'utf8')).toBe(`{ not json ${oldDir}`)
  })
})

describe('migrateUserDataDir — options', () => {
  it('leaves shared entries in place and keeps paths into them pointing there', () => {
    fs.mkdirSync(path.join(oldDir, 'cc-accounts', 'acc_1'), { recursive: true })
    fs.writeFileSync(
      path.join(oldDir, 'accounts.json'),
      JSON.stringify({
        accounts: [{ configDir: path.join(oldDir, 'cc-accounts', 'acc_1') }],
        sessions: path.join(oldDir, 'sessions')
      })
    )

    expect(migrateUserDataDir(oldDir, newDir, { shared: ['cc-accounts'] }).migrated).toBe(true)

    expect(fs.existsSync(path.join(newDir, 'cc-accounts'))).toBe(false)
    const moved = JSON.parse(fs.readFileSync(path.join(newDir, 'accounts.json'), 'utf8'))
    expect(moved.accounts[0].configDir).toBe(path.join(oldDir, 'cc-accounts', 'acc_1'))
    expect(moved.sessions).toBe(path.join(newDir, 'sessions'))
  })

  it('skips extra entries, and carries named ones out of the default skip list', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{}')
    fs.mkdirSync(path.join(oldDir, 'scheduler'))
    fs.writeFileSync(path.join(oldDir, 'Local State'), 'key')
    fs.writeFileSync(path.join(oldDir, 'Preferences'), 'x')

    migrateUserDataDir(oldDir, newDir, { skip: ['scheduler'], carry: ['Local State'] })

    expect(fs.existsSync(path.join(newDir, 'scheduler'))).toBe(false)
    expect(fs.existsSync(path.join(newDir, 'Local State'))).toBe(true)
    expect(fs.existsSync(path.join(newDir, 'Preferences'))).toBe(false)
  })
})

describe('resyncUserDataDir', () => {
  it('replaces imported entries with fresh copies and leaves the rest alone', () => {
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"v":1}')
    fs.mkdirSync(path.join(oldDir, 'sessions'))
    fs.writeFileSync(path.join(oldDir, 'sessions', 'a.json'), '{}')
    migrateUserDataDir(oldDir, newDir, { skip: ['scheduler'] })

    // Dev-side changes: an edit, a session prod never had, and dev's own routines.
    fs.writeFileSync(path.join(newDir, 'config.json'), '{"v":"dev"}')
    fs.writeFileSync(path.join(newDir, 'sessions', 'dev-only.json'), '{}')
    fs.mkdirSync(path.join(newDir, 'scheduler'))
    fs.writeFileSync(path.join(newDir, 'Preferences'), 'chromium')
    // Prod moved on.
    fs.writeFileSync(path.join(oldDir, 'config.json'), '{"v":2}')

    expect(resyncUserDataDir(oldDir, newDir, { skip: ['scheduler'] }).migrated).toBe(true)

    expect(fs.readFileSync(path.join(newDir, 'config.json'), 'utf8')).toBe('{"v":2}')
    expect(fs.existsSync(path.join(newDir, 'sessions', 'dev-only.json'))).toBe(false)
    expect(fs.existsSync(path.join(newDir, 'scheduler'))).toBe(true)
    expect(fs.readFileSync(path.join(newDir, 'Preferences'), 'utf8')).toBe('chromium')
  })
})
