import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { exportNote, removeExport, vaultInfo } from './companion-obsidian'
import type { CompanionNote } from './companion-types'

const note: CompanionNote = { id: 'n1', text: 'porta 8443', createdAt: new Date(2026, 10, 3, 9, 0).getTime(), source: 'text' }

let vault: string
beforeEach(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-vault-'))
})
afterEach(() => {
  fs.rmSync(vault, { recursive: true, force: true })
})

describe('exportNote', () => {
  it('makes the subfolder and never overwrites a file of the same name', () => {
    const prefs = { obsidianVault: vault, obsidianFolder: 'Argos' }
    const first = exportNote(note, prefs)
    const second = exportNote(note, prefs)
    expect(first).toBe(path.join(vault, 'Argos', '2026-11-03-porta-8443.md'))
    expect(second).toBe(path.join(vault, 'Argos', '2026-11-03-porta-8443-2.md'))
    expect(fs.readFileSync(first!, 'utf8')).toContain('porta 8443')
  })

  it('is off without a vault, and skips a vault that is gone', () => {
    expect(exportNote(note, { obsidianVault: '', obsidianFolder: 'Argos' })).toBeNull()
    expect(exportNote(note, { obsidianVault: path.join(vault, 'missing'), obsidianFolder: 'Argos' })).toBeNull()
  })
})

describe('removeExport', () => {
  it('removes the file Argos wrote, but keeps one edited in Obsidian', () => {
    const prefs = { obsidianVault: vault, obsidianFolder: '' }
    const untouched = exportNote(note, prefs)!
    removeExport({ ...note, obsidianPath: untouched })
    expect(fs.existsSync(untouched)).toBe(false)

    const edited = exportNote(note, prefs)!
    fs.appendFileSync(edited, '\nmais uma linha\n')
    removeExport({ ...note, obsidianPath: edited })
    expect(fs.existsSync(edited)).toBe(true)
  })
})

describe('vaultInfo', () => {
  it('tells a vault from a plain folder', () => {
    expect(vaultInfo(vault)).toEqual({ exists: true, isVault: false })
    fs.mkdirSync(path.join(vault, '.obsidian'))
    expect(vaultInfo(vault)).toEqual({ exists: true, isVault: true })
    expect(vaultInfo(path.join(vault, 'nope'))).toEqual({ exists: false, isVault: false })
  })
})
