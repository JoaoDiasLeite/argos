/**
 * Pure helpers for detecting a Claude Code install that its own updater left broken.
 *
 * The CLI self-updates by renaming the running executable to `claude.exe.old.<epoch-ms>` and
 * then writing the new one in its place. If that second step never lands — the update is
 * interrupted, or the file is locked — the npm shim (`claude.cmd`) is left pointing at a
 * `claude.exe` that no longer exists, and every launch dies with the shell's own
 * "is not recognized as an internal or external command". The backup sitting next to it is a
 * complete, working binary, so the repair is simply to put it back.
 */

const BACKUP_RE = /^claude\.exe\.old\.(\d+)$/

/**
 * Pick the most recent `claude.exe.old.<timestamp>` from a directory listing, or null if there
 * is none. Timestamps are compared numerically — string ordering would rank a shorter (older,
 * pre-2001) epoch above a longer one.
 */
export function pickNewestClaudeBackup(names: string[]): string | null {
  let best: string | null = null
  let bestStamp = -1
  for (const name of names) {
    const m = BACKUP_RE.exec(name)
    if (!m) continue
    const stamp = Number(m[1])
    if (!Number.isFinite(stamp)) continue
    if (stamp > bestStamp) {
      bestStamp = stamp
      best = name
    }
  }
  return best
}

/** True when a bin/ listing shows the updater's rename with no executable left behind. */
export function isClaudeBinBroken(names: string[]): boolean {
  return !names.includes('claude.exe') && pickNewestClaudeBackup(names) !== null
}
