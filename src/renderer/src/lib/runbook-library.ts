import { fetchBuiltinRunbook, samePath } from './builtin-runbook'

/**
 * Where the runbooks come from: the runbooks folder of Settings (`config.ops.runbooksDir`,
 * every direct subfolder that looks like a runbook) and the loose runbooks picked one by
 * one (`config.ops.runbookFolders`). Both are references: the folders stay where they
 * are, so a git pull updates them, and Argos only reads them.
 *
 * The start screen (Servers → Ops), Settings → Intervenções and the Remote view's Ops
 * button read them through here.
 */

/** Before the runbooks lived in config: the start screen's recents, most recent first. */
const LEGACY_RECENTS_KEY = 'ops.recentRunbooks'
/** The runbook the last runbook intervention started with: the start screen's default pick. */
const LAST_RUNBOOK_KEY = 'ops.lastRunbook'

export interface RunbookSources {
  /** The runbooks folder, or null when none is set. */
  dir: string | null
  /** Its runbooks, by name; empty when the folder could not be listed. */
  library: { path: string; name: string }[]
  /** Why the folder could not be listed. */
  libraryError?: string
  /** The loose runbooks, as stored (one may also be in the library). */
  loose: string[]
}

function readLegacyRecents(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_RECENTS_KEY)
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string' && p !== '') : []
  } catch {
    return []
  }
}

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|[\\/])/.test(p)

let migrating: Promise<void> | null = null

/**
 * One time: the recents of `ops.recentRunbooks` become the loose runbooks when config has
 * none yet (`runbookFolders` never set). The built-in runbook is left out, localStorage is
 * left as it was, and the most recent one seeds the last-used runbook. Once config holds a
 * list, even an empty one, this does nothing.
 */
export function migrateRecentRunbooks(): Promise<void> {
  migrating ??= (async () => {
    const dirs = await window.electronAPI.opsDirs()
    if (dirs.runbookFolders !== null) return
    const recents = readLegacyRecents()
    if (recents.length === 0) return
    const builtin = await fetchBuiltinRunbook()
    const folders = recents.filter((p) => isAbsolute(p) && !samePath(p, builtin))
    const r = await window.electronAPI.setOpsPrefs({ runbookFolders: folders })
    if (r.ok && folders[0] && !readLastRunbook()) writeLastRunbook(folders[0])
  })().catch(() => {
    migrating = null
  })
  return migrating
}

/** The runbooks folder listed (rescanned on every call) and the loose runbooks. */
export async function readRunbookSources(): Promise<RunbookSources> {
  await migrateRecentRunbooks()
  const [dirs, scan] = await Promise.all([
    window.electronAPI.opsDirs(),
    window.electronAPI
      .opsScanRunbooks()
      .catch((e): { ok: false; error: string } => ({ ok: false, error: e instanceof Error ? e.message : String(e) }))
  ])
  const loose = dirs.runbookFolders ?? []
  if (!scan.ok) return { dir: dirs.runbooksDir, library: [], libraryError: scan.error, loose }
  return { dir: scan.dir, library: scan.entries, loose }
}

/** Every runbook folder of `sources`, the library first, a loose one already in it left out. */
export function allRunbookPaths(sources: RunbookSources): string[] {
  return [...sources.library.map((e) => e.path), ...looseOnly(sources)]
}

/** The loose runbooks that are not also in the library. */
export function looseOnly(sources: RunbookSources): string[] {
  return sources.loose.filter((p) => !sources.library.some((e) => samePath(e.path, p)))
}

export function readLastRunbook(): string | null {
  try {
    return localStorage.getItem(LAST_RUNBOOK_KEY) || null
  } catch {
    return null
  }
}

export function writeLastRunbook(dir: string): void {
  try {
    localStorage.setItem(LAST_RUNBOOK_KEY, dir)
  } catch {
    /* storage unavailable: the default pick just falls back to the first usable one */
  }
}
