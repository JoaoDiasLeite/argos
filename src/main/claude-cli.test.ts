import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { repairClaudeCliAt, claudeBinDirs } from './claude-cli'

let binDir: string

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-test-'))
})

afterEach(() => {
  fs.rmSync(binDir, { recursive: true, force: true })
})

describe('repairClaudeCliAt', () => {
  it('restores claude.exe from the backup, leaving the backup in place', () => {
    fs.writeFileSync(path.join(binDir, 'claude.exe.old.1785147984009'), 'BINARY')

    const result = repairClaudeCliAt(binDir)

    expect(result.repaired).toBe(true)
    expect(fs.readFileSync(path.join(binDir, 'claude.exe'), 'utf8')).toBe('BINARY')
    // A copy, not a move — the updater expects its own backup to still be there.
    expect(fs.existsSync(path.join(binDir, 'claude.exe.old.1785147984009'))).toBe(true)
  })

  it('restores from the newest backup when several have piled up', () => {
    fs.writeFileSync(path.join(binDir, 'claude.exe.old.1785147000000'), 'OLD')
    fs.writeFileSync(path.join(binDir, 'claude.exe.old.1785147984009'), 'NEW')

    expect(repairClaudeCliAt(binDir).repaired).toBe(true)
    expect(fs.readFileSync(path.join(binDir, 'claude.exe'), 'utf8')).toBe('NEW')
  })

  it('leaves a healthy install alone', () => {
    fs.writeFileSync(path.join(binDir, 'claude.exe'), 'LIVE')
    fs.writeFileSync(path.join(binDir, 'claude.exe.old.1785147984009'), 'BACKUP')

    expect(repairClaudeCliAt(binDir).repaired).toBe(false)
    expect(fs.readFileSync(path.join(binDir, 'claude.exe'), 'utf8')).toBe('LIVE')
  })

  it('does nothing when there is no backup to restore from', () => {
    expect(repairClaudeCliAt(binDir).repaired).toBe(false)
    expect(fs.existsSync(path.join(binDir, 'claude.exe'))).toBe(false)
  })

  it('is a no-op for a directory that does not exist', () => {
    const result = repairClaudeCliAt(path.join(binDir, 'nope'))
    expect(result.repaired).toBe(false)
    expect(result.detail).toBeUndefined()
  })

  it('is idempotent — a second run finds nothing to do', () => {
    fs.writeFileSync(path.join(binDir, 'claude.exe.old.1785147984009'), 'BINARY')
    expect(repairClaudeCliAt(binDir).repaired).toBe(true)
    expect(repairClaudeCliAt(binDir).repaired).toBe(false)
  })
})

describe('claudeBinDirs', () => {
  it('derives the npm-global and nodejs bin dirs from the environment', () => {
    const dirs = claudeBinDirs({ APPDATA: 'C:\\A', ProgramFiles: 'C:\\PF' } as NodeJS.ProcessEnv)
    expect(dirs).toEqual([
      path.join('C:\\A', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
      path.join('C:\\PF', 'nodejs', 'node_modules', '@anthropic-ai', 'claude-code', 'bin')
    ])
  })

  it('skips roots the environment does not define', () => {
    expect(claudeBinDirs({} as NodeJS.ProcessEnv)).toEqual([])
  })
})
