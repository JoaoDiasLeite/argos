/**
 * How a Windows file path — from a drop, or from files copied in Explorer — is typed
 * into a terminal so that the CLI on the other side can open it.
 *
 * Every path arrives as Windows sees it, and only a local terminal shares that view:
 *
 * - **Local** gets it as is, in double quotes when it has a space, the way Windows
 *   Terminal types a dropped file.
 * - **WSL** gets the distro's own name for it, as its `wslpath` answers — `C:\dev\x` is
 *   `/mnt/c/dev/x` unless the distro mounts its drives somewhere else. A file inside that
 *   same distro's share (`\\wsl.localhost\Ubuntu\home\me`) is `/home/me`; another
 *   distro's is out of reach. Shell-quoted, since it lands at a bash-like prompt. Should
 *   the distro not answer, the default mount is assumed rather than typing nothing.
 * - **SSH** gets nothing. The file is on this machine and the shell is on that one, and
 *   a path that silently points at nothing is worse than no path.
 */
export interface TerminalPathEnv {
  wslDistro?: string
  remoteHostId?: string
}

const WSL_SHARE = /^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(\\.*)?$/i
const DRIVE = /^([a-zA-Z]):[\\/](.*)$/

/**
 * The path as the terminal's CLI would name it, or null when it cannot reach it.
 *
 * `linux` is the distro's own answer for a WSL terminal (`wslToLinuxPaths`): a path to
 * use, null for one it cannot reach, or undefined when it was not asked.
 */
export function terminalPathFor(winPath: string, env: TerminalPathEnv, linux?: string | null): string | null {
  if (env.remoteHostId) return null
  if (!env.wslDistro) return /[\s&()^;,]/.test(winPath) ? `"${winPath}"` : winPath

  // Another distro's files are not reachable from this one under any name. Decided
  // before the distro's answer is used: wslpath returns nonsense for these, not an error.
  const share = WSL_SHARE.exec(winPath)
  if (share && share[1].toLowerCase() !== env.wslDistro.toLowerCase()) return null

  if (linux !== undefined) return linux === null ? null : shellQuote(linux)

  // The distro was not asked, or did not answer: its default layout.
  if (share) return shellQuote((share[2] ?? '\\').replace(/\\/g, '/'))
  const drive = DRIVE.exec(winPath)
  if (drive) return shellQuote(`/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, '/')}`)
  // Any other UNC share: the distro has no mount for it.
  return null
}

/**
 * The text to type for a set of paths: each one the CLI can reach, space-separated,
 * with a trailing space so the next word typed is not glued onto the last path.
 * Empty when none of them can be reached. `linuxPaths` is the distro's answer for
 * each, in order, as for `terminalPathFor`.
 */
export function terminalPathsText(
  winPaths: string[],
  env: TerminalPathEnv,
  linuxPaths?: (string | null)[] | null
): string {
  const out = winPaths
    .map((p, i) => terminalPathFor(p, env, linuxPaths ? linuxPaths[i] : undefined))
    .filter((p): p is string => !!p)
  return out.length ? out.join(' ') + ' ' : ''
}

function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`
}
