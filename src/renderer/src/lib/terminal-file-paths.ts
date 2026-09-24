/**
 * How a Windows file path — from a drop, or from files copied in Explorer — is typed
 * into a terminal so that the CLI on the other side can open it.
 *
 * Every path arrives as Windows sees it, and only a local terminal shares that view:
 *
 * - **Local** gets it as is, in double quotes when it has a space, the way Windows
 *   Terminal types a dropped file.
 * - **WSL** gets the distro's own name for it: `C:\dev\x` is `/mnt/c/dev/x`, and a file
 *   inside that same distro's share (`\\wsl.localhost\Ubuntu\home\me`) is `/home/me`.
 *   Shell-quoted, since it lands at a bash-like prompt.
 * - **SSH** gets nothing. The file is on this machine and the shell is on that one, and
 *   a path that silently points at nothing is worse than no path.
 */
export interface TerminalPathEnv {
  wslDistro?: string
  remoteHostId?: string
}

const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i
const DRIVE = /^([a-zA-Z]):[\\/](.*)$/

/** The path as the terminal's CLI would name it, or null when it cannot reach it. */
export function terminalPathFor(winPath: string, env: TerminalPathEnv): string | null {
  if (env.remoteHostId) return null
  if (!env.wslDistro) return /[\s&()^;,]/.test(winPath) ? `"${winPath}"` : winPath

  const share = WSL_SHARE.exec(winPath)
  if (share) {
    // Another distro's files are not reachable from this one under any name.
    if (share[1].toLowerCase() !== env.wslDistro.toLowerCase()) return null
    return shellQuote((share[2] ?? '\\').replace(/\\/g, '/'))
  }
  const drive = DRIVE.exec(winPath)
  if (drive) return shellQuote(`/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`)
  // Any other UNC share: the distro has no mount for it.
  return null
}

/**
 * The text to type for a set of paths: each one the CLI can reach, space-separated,
 * with a trailing space so the next word typed is not glued onto the last path.
 * Empty when none of them can be reached.
 */
export function terminalPathsText(winPaths: string[], env: TerminalPathEnv): string {
  const out = winPaths.map((p) => terminalPathFor(p, env)).filter((p): p is string => !!p)
  return out.length ? out.join(' ') + ' ' : ''
}

function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}
