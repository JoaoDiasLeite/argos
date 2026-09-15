import * as fs from 'fs'
import * as path from 'path'

/**
 * One-time import of the app's data from a previous userData directory.
 *
 * Electron derives userData from the app's name, so renaming the app (claude-gui -> argos)
 * points it at an empty folder and every chat, account login, SSH host, sprint and checkpoint
 * looks lost. This copies the old directory's contents across on first launch under the new
 * name. A copy, not a move: the old install keeps working, so rolling back stays possible.
 *
 * Absolute paths stored *inside* that data are rewritten too — accounts.json records each
 * Claude account's config dir as a full path under the old userData root, so without this the
 * accounts would keep reading and writing the old location (and break outright once the user
 * deletes it).
 */

/** Chromium/runtime state belonging to the old app identity. Rebuilt on first launch; the
 *  single-instance lockfile would be actively harmful to bring along. */
const SKIP = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Local Storage',
  'Session Storage',
  'Shared Dictionary',
  'Network',
  'blob_storage',
  'DIPS',
  'DIPS-wal',
  'Local State',
  'Preferences',
  'lockfile',
  'SingletonLock',
  'SingletonCookie'
])

/** Written into the new directory so the import is never attempted twice. */
export const MARKER = 'migrated-from.json'

/** Files whose presence means the new directory is already in use — never clobber it. */
const IN_USE_MARKERS = ['config.json', 'accounts.json', 'sessions']

export interface MigrationResult {
  migrated: boolean
  detail?: string
}

/**
 * Rewrite every string that starts with `oldRoot` to sit under `newRoot` instead.
 *
 * Works on parsed JSON rather than raw text on purpose: the file stores Windows paths with
 * escaped backslashes (`C:\\Users\\…`), so a naive text replace of the plain path would never
 * match. Prefix-only matching also protects unrelated paths that merely *contain* the old app
 * name — a project folder called `claude-gui` must not be touched.
 */
export function rewritePaths(
  value: unknown,
  oldRoot: string,
  newRoot: string,
  shared: string[] = []
): unknown {
  if (typeof value === 'string') {
    if (!value.startsWith(oldRoot)) return value
    // A path into a shared entry keeps pointing at the old directory — that entry was
    // never copied, so the rewritten path would lead nowhere.
    const rest = value.slice(oldRoot.length).replace(/^[\\/]+/, '')
    if (shared.some((s) => rest === s || rest.startsWith(s + '\\') || rest.startsWith(s + '/'))) {
      return value
    }
    return newRoot + value.slice(oldRoot.length)
  }
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, oldRoot, newRoot, shared))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = rewritePaths(v, oldRoot, newRoot, shared)
    return out
  }
  return value
}

/** Apply rewritePaths to every .json file in the tree, in place. Best-effort per file. */
function rewriteJsonTree(
  dir: string,
  oldRoot: string,
  newRoot: string,
  shared: string[],
  depth = 0
): void {
  if (depth > 3) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      rewriteJsonTree(p, oldRoot, newRoot, shared, depth + 1)
      continue
    }
    if (!entry.name.endsWith('.json')) continue
    try {
      const text = fs.readFileSync(p, 'utf8')
      if (!text.includes(oldRoot.split('\\').join('\\\\')) && !text.includes(oldRoot)) continue
      const rewritten = rewritePaths(JSON.parse(text), oldRoot, newRoot, shared)
      fs.writeFileSync(p, JSON.stringify(rewritten, null, 2), 'utf8')
    } catch {
      // A malformed or unreadable file is left exactly as copied rather than truncated.
    }
  }
}

export interface MigrationOptions {
  /** Top-level entries not to copy at all. */
  skip?: string[]
  /** Entries in the default skip list to copy anyway. */
  carry?: string[]
  /** Top-level entries left in the old directory and used from there: not copied, and
   *  paths pointing into them are not rewritten. */
  shared?: string[]
}

/**
 * Throw away what an earlier import brought into `newDir` and import again.
 *
 * Only entries the import would copy are removed — anything `newDir` holds that the old
 * directory does not (or that the options skip) is left alone, and so is the runtime state
 * the default skip list covers, which a running app is holding open.
 */
export function resyncUserDataDir(
  oldDir: string,
  newDir: string,
  options: MigrationOptions = {}
): MigrationResult {
  try {
    if (path.resolve(oldDir) === path.resolve(newDir)) return { migrated: false }
    if (!fs.existsSync(oldDir)) return { migrated: false, detail: `${oldDir} does not exist` }
    const skip = new Set([...SKIP, ...(options.skip ?? []), ...(options.shared ?? [])])
    for (const entry of fs.readdirSync(oldDir)) {
      if (skip.has(entry)) continue
      fs.rmSync(path.join(newDir, entry), { recursive: true, force: true })
    }
    fs.rmSync(path.join(newDir, MARKER), { force: true })
    // Runtime state stays out of a resync even when the first import carried it.
    return migrateUserDataDir(oldDir, newDir, { ...options, carry: [] })
  } catch (e) {
    return { migrated: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

export function migrateUserDataDir(
  oldDir: string,
  newDir: string,
  options: MigrationOptions = {}
): MigrationResult {
  const shared = options.shared ?? []
  const skip = new Set([...SKIP, ...(options.skip ?? []), ...shared])
  for (const name of options.carry ?? []) skip.delete(name)
  try {
    if (path.resolve(oldDir) === path.resolve(newDir)) return { migrated: false }
    if (!fs.existsSync(oldDir)) return { migrated: false }
    if (fs.existsSync(path.join(newDir, MARKER))) return { migrated: false }
    // Already carrying data (a fresh install that's been used, or a seeded test instance):
    // importing on top of it would overwrite real state.
    if (fs.existsSync(newDir) && IN_USE_MARKERS.some((m) => fs.existsSync(path.join(newDir, m)))) {
      return { migrated: false, detail: `${newDir} already has data; skipped import` }
    }

    fs.mkdirSync(newDir, { recursive: true })
    let copied = 0
    for (const entry of fs.readdirSync(oldDir, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue
      fs.cpSync(path.join(oldDir, entry.name), path.join(newDir, entry.name), {
        recursive: true,
        force: true
      })
      copied++
    }
    if (copied === 0) return { migrated: false }

    rewriteJsonTree(newDir, oldDir, newDir, shared)
    fs.writeFileSync(
      path.join(newDir, MARKER),
      JSON.stringify({ from: oldDir, entries: copied }, null, 2),
      'utf8'
    )
    return { migrated: true, detail: `imported ${copied} entries from ${oldDir}` }
  } catch (e) {
    return { migrated: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
