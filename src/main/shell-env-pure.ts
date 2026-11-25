import * as path from 'path'

/**
 * Pure helpers for reading the user's login-shell environment on macOS. An app started
 * from Finder or the Dock gets launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so the CLIs Argos spawns — claude, codex, gemini, agy, node for their shebangs, npx
 * for MCP servers — are not found. shell-env.ts runs the login shell once, and these
 * functions build its command line and read its output. No fs or process access here.
 */

/** Printed around the env dump, so whatever the rc files print is skipped. */
export const ENV_MARKER = '__ARGOS_SHELL_ENV_6d1f0c__'

/**
 * The command handed to `$SHELL -ilc`. Only external programs by absolute path, no
 * shell syntax beyond `;` and single quotes, so it reads the same in zsh, bash and fish.
 */
export function shellEnvCommand(): string {
  return `/usr/bin/printf '%s' '${ENV_MARKER}'; /usr/bin/env -0; /usr/bin/printf '%s' '${ENV_MARKER}'`
}

/**
 * The environment between the first and the last marker of `stdout`, as written by
 * `env -0` (NUL-separated NAME=value). Null when the markers are missing — the shell
 * failed, timed out, or `env -0` is not supported — or nothing parsed.
 */
export function parseEnvDump(stdout: string): Record<string, string> | null {
  const start = stdout.indexOf(ENV_MARKER)
  const end = stdout.lastIndexOf(ENV_MARKER)
  if (start < 0 || end <= start) return null
  const body = stdout.slice(start + ENV_MARKER.length, end)
  const env: Record<string, string> = {}
  let count = 0
  for (const entry of body.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const name = entry.slice(0, eq)
    // A name with whitespace or a newline is junk, not an env var.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue
    env[name] = entry.slice(eq + 1)
    count++
  }
  return count > 0 ? env : null
}

function splitPath(value: string | undefined): string[] {
  return (value || '').split(':').filter(Boolean)
}

/**
 * `current` with the dirs of `shellPath` it lacks put in front, in the shell's order:
 * the login shell's PATH is what the user sees in Terminal, so it wins over launchd's.
 */
export function prependPathDirs(current: string | undefined, shellPath: string | undefined): string {
  const have = splitPath(current)
  const missing: string[] = []
  for (const dir of splitPath(shellPath)) {
    if (!have.includes(dir) && !missing.includes(dir)) missing.push(dir)
  }
  return [...missing, ...have].join(':')
}

/** `current` with any of `extra` it lacks appended — the existing PATH keeps priority. */
export function appendPathDirs(current: string | undefined, extra: string[]): string {
  const dirs = splitPath(current)
  for (const dir of extra) {
    if (dir && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs.join(':')
}

/**
 * Where CLIs usually live on a Mac when the login shell could not be read: Homebrew on
 * Apple Silicon and on Intel, Claude Code's native installer, and npm's documented
 * global prefix. The caller keeps only the ones that exist.
 */
export function darwinFallbackDirs(home: string): string[] {
  return [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.local', 'bin'),
    path.posix.join(home, '.npm-global', 'bin')
  ]
}

/**
 * The changes to apply to `current` from the login shell's `shellEnv`: PATH gains the
 * shell's missing dirs in front; SSH_AUTH_SOCK is taken only when unset. Nothing else is
 * copied — the app's own env is otherwise launchd's, and that is fine.
 */
export function shellEnvUpdates(
  current: Record<string, string | undefined>,
  shellEnv: Record<string, string>
): Record<string, string> {
  const updates: Record<string, string> = {}
  if (shellEnv.PATH) {
    const merged = prependPathDirs(current.PATH, shellEnv.PATH)
    if (merged !== (current.PATH || '')) updates.PATH = merged
  }
  if (!current.SSH_AUTH_SOCK && shellEnv.SSH_AUTH_SOCK) updates.SSH_AUTH_SOCK = shellEnv.SSH_AUTH_SOCK
  return updates
}
