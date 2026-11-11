import * as fs from 'fs'
import * as path from 'path'
import { classifyJsonRead, staleCorruptCopies, type JsonLoad } from './json-load-pure'

/** Read and parse a JSON file, tolerating a UTF-8 BOM (external tools like
 *  PowerShell 5.1 write one; bare JSON.parse throws on it). Throws like
 *  JSON.parse on invalid JSON — callers keep their existing error handling. */
export function readJsonFile<T = unknown>(p: string): T {
  let raw = fs.readFileSync(p, 'utf-8')
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  return JSON.parse(raw) as T
}

/**
 * Write JSON by writing a sibling temp file and renaming it over the target.
 *
 * `rename` is atomic within a directory, so a reader either sees the whole old file
 * or the whole new one — never a half-written config. Worth the extra syscalls
 * anywhere the file belongs to something other than us: Claude Code's `.claude.json`
 * holds settings this app knows nothing about, and truncating it partway through
 * costs the user more than the operation was ever worth.
 */
export function writeJsonFileAtomic(p: string, value: unknown): void {
  // Beside the target, not in the system temp dir: `rename` is only atomic within a
  // filesystem, and the two are routinely on different ones.
  const tmp = `${p}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8')
    fs.renameSync(tmp, p)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Already gone, or never made.
    }
    throw e
  }
}

/** Corrupt copies kept per file; older ones are deleted. */
const KEEP_CORRUPT_COPIES = 3

/**
 * Read a JSON state file and say what to do about the outcome (see json-load-pure.ts).
 * A `corrupt` file is copied to `<name>.corrupt-<ms>` beside it first (best effort, never
 * throws), so the defaults the caller falls back to cannot bury the only copy of what was
 * in it. An `unreadable` file (transient lock) is left alone; the caller should refuse to
 * overwrite it this session.
 */
export function loadJsonFileGuarded<T>(p: string, accept: (v: unknown) => v is T): JsonLoad<T> {
  const result = classifyJsonRead<T>(() => readJsonFile<unknown>(p), accept)
  if (result.kind === 'corrupt') {
    try {
      fs.copyFileSync(p, `${p}.corrupt-${Date.now()}`)
      const dir = path.dirname(p)
      const base = path.basename(p)
      for (const stale of staleCorruptCopies(fs.readdirSync(dir), base, KEEP_CORRUPT_COPIES)) {
        try {
          fs.unlinkSync(path.join(dir, stale))
        } catch {
          // Locked or already gone.
        }
      }
    } catch {
      // Best effort: the file may have vanished or the folder be read-only.
    }
  } else if (result.kind === 'unreadable') {
    console.warn(`[argos] could not read ${p}; leaving it untouched and not saving over it this session`, result.error)
  }
  return result
}
