// One-shot export of pre-2.0 chat transcripts (docs/TERMINAL_ONLY_PLAN.md §3).
// Directories come in as parameters so this stays electron-free and testable.
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { LegacySession, exportFileName, migrateSession, upgradeSession } from './session-migrate-pure'

export interface MigrationState {
  version: '2.0.0'
  ranAt: number
  exported: number
  failed: { id: string; error: string }[]
}

export interface MigrateLegacySessionsOptions {
  sessionsDir: string
  backupDir: string
  exportsDir: string
  writeState: (state: MigrationState) => void | Promise<void>
}

export interface MigrateLegacySessionsResult {
  exported: number
  /** Messageless pre-2.0 sessions rewritten to the 2.0 shape (no export, no backup). */
  upgraded: number
  skipped: number
  failed: { id: string; error: string }[]
}

/**
 * Write a new file, never replacing one. An existing identical file counts as done (a
 * retry after a later step failed). An existing *different* file is kept and the data
 * goes to the next free `<stem>.2<ext>`, `<stem>.3<ext>`…: seen on the first real run,
 * where the dev instance re-seeds its sessions from the production folder, so the same
 * id came back with newer content and a backup already sat there. Both copies are worth
 * keeping; refusing would have left that session unmigrated for good. Returns the path
 * actually written.
 */
function writeOnce(p: string, data: Buffer | string): string {
  const wanted = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
  const ext = path.extname(p)
  const stem = p.slice(0, p.length - ext.length)
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? p : `${stem}.${n}${ext}`
    try {
      fs.writeFileSync(candidate, wanted, { flag: 'wx' })
      return candidate
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (fs.readFileSync(candidate).equals(wanted)) return candidate
    }
  }
  throw new Error(`${path.basename(p)}: too many existing copies`)
}

/**
 * For every session JSON with messages: back up the original byte-for-byte, export
 * the transcript as Markdown, then rewrite the session without its SDK fields. A file
 * that fails at any step keeps its original JSON (a backup already written is kept)
 * and is retried next launch; the loop carries on with the rest.
 */
export async function migrateLegacySessions(opts: MigrateLegacySessionsOptions): Promise<MigrateLegacySessionsResult> {
  const { sessionsDir, backupDir, exportsDir, writeState } = opts
  const result: MigrateLegacySessionsResult = { exported: 0, upgraded: 0, skipped: 0, failed: [] }

  let files: string[]
  try {
    files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json'))
  } catch {
    files = []
  }

  for (const file of files) {
    const src = path.join(sessionsDir, file)
    let id = file.replace(/\.json$/, '')
    try {
      const legacy = readJsonFile<LegacySession>(src)
      if (!legacy || typeof legacy !== 'object') throw new Error('not a session object')
      if (typeof legacy.id === 'string' && legacy.id) id = legacy.id
      else legacy.id = id

      const name = exportFileName(legacy)
      const exportPath = path.join(exportsDir, name)
      const outcome = migrateSession(legacy, exportPath)
      if ('skip' in outcome) {
        // Nothing to export; settings only, so no backup either.
        const upgraded = upgradeSession(legacy)
        if (upgraded) {
          writeJsonFileAtomic(src, upgraded)
          result.upgraded++
        } else {
          result.skipped++
        }
        continue
      }

      const original = fs.readFileSync(src)
      fs.mkdirSync(backupDir, { recursive: true })
      writeOnce(path.join(backupDir, file), original)
      fs.mkdirSync(exportsDir, { recursive: true })
      const written = writeOnce(exportPath, outcome.markdown)
      // The export may have landed on a numbered copy; the session must point at that one.
      writeJsonFileAtomic(src, { ...outcome.session, archivedTranscript: written })
      result.exported++
    } catch (e) {
      result.failed.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  await writeState({ version: '2.0.0', ranAt: Date.now(), exported: result.exported, failed: result.failed })
  return result
}
