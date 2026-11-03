/**
 * Writes companion notes into the Obsidian vault (docs/COMPANION_PLAN.md §6.2). Off while
 * `prefs.obsidianVault` is empty. Never throws: a vault on a drive that went away must
 * not lose the capture, which is already safe in notes.json.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { CompanionNote, CompanionPrefs } from './companion-types'
import { candidateName, exportDir, noteFileName, noteMarkdown } from './companion-obsidian-pure'

/** Give up on a name after this many `-n` suffixes. */
const MAX_TRIES = 50

export interface ObsidianVaultInfo {
  /** The folder exists. */
  exists: boolean
  /** It has a `.obsidian/` folder: Obsidian has opened it as a vault. */
  isVault: boolean
}

export function vaultInfo(dir: string): ObsidianVaultInfo {
  const isDir = (p: string): boolean => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  }
  const exists = !!dir && path.isAbsolute(dir) && isDir(dir)
  return { exists, isVault: exists && isDir(path.join(dir, '.obsidian')) }
}

/**
 * Writes the note as a new file and returns its path, or null when the export is off,
 * the vault is gone or the write failed. Never overwrites: a taken name gets `-2`, `-3`…
 */
export function exportNote(note: CompanionNote, prefs: Pick<CompanionPrefs, 'obsidianVault' | 'obsidianFolder'>): string | null {
  const dir = exportDir(prefs.obsidianVault, prefs.obsidianFolder)
  // The vault itself must exist; the subfolder is made on first use.
  if (!dir || !vaultInfo(prefs.obsidianVault).exists) return null
  try {
    fs.mkdirSync(dir, { recursive: true })
    const base = noteFileName(note)
    const body = noteMarkdown(note)
    for (let n = 1; n <= MAX_TRIES; n++) {
      const file = path.join(dir, candidateName(base, n))
      try {
        fs.writeFileSync(file, body, { encoding: 'utf8', flag: 'wx' })
        return file
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
  } catch (e) {
    console.warn('[companion] obsidian export failed:', e instanceof Error ? e.message : e)
  }
  return null
}

/**
 * Ctrl+Z on a capture: its exported file goes too, but only while it still holds what
 * Argos wrote. A file already edited in Obsidian is someone's work and stays.
 */
export function removeExport(note: CompanionNote): void {
  const file = note.obsidianPath
  if (!file) return
  try {
    if (fs.readFileSync(file, 'utf8') === noteMarkdown(note)) fs.unlinkSync(file)
  } catch {
    // Already gone, or the vault is unreachable: nothing to undo.
  }
}
