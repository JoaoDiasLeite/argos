import * as fs from 'fs'
import * as path from 'path'
import { isClaudeBinBroken, pickNewestClaudeBackup } from './claude-cli-pure'

/**
 * Repairing a Claude Code install whose own updater left it without an executable.
 *
 * The npm shim we resolve to (`claude.cmd`) execs
 * `<npm-root>/node_modules/@anthropic-ai/claude-code/bin/claude.exe`. The CLI self-updates by
 * renaming that file to `claude.exe.old.<epoch-ms>` and writing a new one; when the second step
 * doesn't land, the shim still exists (so every "is it installed?" check passes) but launching it
 * fails with the shell's own "not recognized" error, which is what surfaces in a chat terminal.
 * The backup is a complete binary, so restoring it gets the user working again immediately — no
 * network needed — and lets the CLI finish its own update on the next run.
 *
 * Deliberately free of any electron import so it stays unit-testable against a temp dir.
 */

/** Restore `claude.exe` in one bin dir. Copies, so the updater's backup stays put. */
export function repairClaudeCliAt(binDir: string): { repaired: boolean; detail?: string } {
  try {
    if (!fs.existsSync(binDir)) return { repaired: false }
    const names = fs.readdirSync(binDir)
    if (!isClaudeBinBroken(names)) return { repaired: false }
    const backup = pickNewestClaudeBackup(names)
    if (!backup) return { repaired: false }
    fs.copyFileSync(path.join(binDir, backup), path.join(binDir, 'claude.exe'))
    return { repaired: true, detail: `restored claude.exe from ${backup} in ${binDir}` }
  } catch (e) {
    return { repaired: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/** The npm global roots a Windows install of the CLI can live under. */
export function claudeBinDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots: string[] = []
  if (env.APPDATA) roots.push(path.join(env.APPDATA, 'npm'))
  if (env.ProgramFiles) roots.push(path.join(env.ProgramFiles, 'nodejs'))
  return roots.map((r) => path.join(r, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'))
}

/** Best-effort and idempotent: does nothing unless the breakage is actually present. */
export function repairClaudeCliIfBroken(): { repaired: boolean; detail?: string } {
  if (process.platform !== 'win32') return { repaired: false }
  for (const binDir of claudeBinDirs()) {
    const result = repairClaudeCliAt(binDir)
    if (result.repaired || result.detail) return result
  }
  return { repaired: false }
}
