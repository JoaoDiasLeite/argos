// One-shot export of pre-2.0 chat transcripts (docs/TERMINAL_ONLY_PLAN.md §3).
// Directories come in as parameters so this stays electron-free and testable.
import * as fs from 'fs'
import * as path from 'path'
import { readJsonFile, writeJsonFileAtomic } from './json-file'
import { LegacySession, exportFileName, migrateSession } from './session-migrate-pure'

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
  skipped: number
  failed: { id: string; error: string }[]
}

/** Write a new file, never replacing one. An existing identical file counts as done
 *  (a retry after a later step failed); a different one is an error. */
function writeOnce(p: string, data: Buffer | string): void {
  try {
    fs.writeFileSync(p, data, { flag: 'wx' })
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    const existing = fs.readFileSync(p)
    const wanted = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data
    if (!existing.equals(wanted)) throw new Error(`${path.basename(p)} already exists with different content`)
  }
}

/**
 * For every session JSON with messages: back up the original byte-for-byte, export
 * the transcript as Markdown, then rewrite the session without its SDK fields. A file
 * that fails at any step keeps its original JSON (a backup already written is kept)
 * and is retried next launch; the loop carries on with the rest.
 */
export async function migrateLegacySessions(opts: MigrateLegacySessionsOptions): Promise<MigrateLegacySessionsResult> {
  const { sessionsDir, backupDir, exportsDir, writeState } = opts
  const result: MigrateLegacySessionsResult = { exported: 0, skipped: 0, failed: [] }

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
        result.skipped++
        continue
      }

      const original = fs.readFileSync(src)
      fs.mkdirSync(backupDir, { recursive: true })
      writeOnce(path.join(backupDir, file), original)
      fs.mkdirSync(exportsDir, { recursive: true })
      writeOnce(exportPath, outcome.markdown)
      writeJsonFileAtomic(src, outcome.session)
      result.exported++
    } catch (e) {
      result.failed.push({ id, error: e instanceof Error ? e.message : String(e) })
    }
  }

  await writeState({ version: '2.0.0', ranAt: Date.now(), exported: result.exported, failed: result.failed })
  return result
}
