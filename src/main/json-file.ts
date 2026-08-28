import * as fs from 'fs'

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
