/**
 * Normalise a project path into a key that identifies the same folder regardless of
 * how it was spelled when a particular session recorded it.
 *
 * On Windows the same folder reaches sessions as both `...\claude-gui` and
 * `...\Claude-GUI` (case-preserving but case-insensitive filesystem, plus whichever
 * tool wrote the path choosing its own casing), and separators vary between `\` and
 * `/` depending on which shell launched the session. Grouping sessions by the raw
 * path string then shows the same project twice — this key makes the two collapse
 * into one.
 *
 * A folder inside a WSL distro is harder, because it is not spelled differently so
 * much as *addressed* differently: one and the same directory reaches the sidebar as
 * `/home/me/proj` from a chat running inside the distro, as
 * `\\wsl.localhost\Ubuntu\home\me\proj` from a chat on the Windows side, and as
 * `Z:\home\me\proj` when that UNC root is mapped to a drive letter. Those fold
 * together here too, onto the UNC spelling — see `canonicalProjectPath`.
 */

/** Drive letters mapped to a WSL distro root, and POSIX paths whose distro is known. */
export interface ProjectKeyContext {
  /** Drive letter (lower-case, with colon) → distro name, e.g. `{ 'z:': 'Ubuntu' }`. */
  driveMap?: Record<string, string>
  /**
   * Lower-cased POSIX path → the distro a session was seen running it in. Lets a chat
   * that recorded a bare `/home/me/proj` and no distro of its own still join the group,
   * on the evidence of another chat in the same folder that did name one. Build it with
   * `buildPosixDistroMap`.
   */
  posixDistros?: Map<string, string>
}

/** `//wsl.localhost/<distro>/rest` or the older `//wsl$/<distro>/rest`, slash-normalised. */
const WSL_UNC = /^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i
const DRIVE = /^([A-Za-z]:)(\/.*)?$/
/** WSL's mount of a Windows drive: `/mnt/c/dev/x`. Only a single letter — `/mnt/cdrom`
 *  is a folder like any other. The mount root is `/mnt` unless wsl.conf says otherwise,
 *  which is rare enough not to go looking for. */
const MNT_DRIVE = /^\/mnt\/([A-Za-z])(\/.*)?$/
/**
 * Git Bash / MSYS spelling of a Windows path: `/c/Users/me/proj` for `C:\Users\me\proj`.
 * A WSL session can record it too — App.tsx calls both this and `/mnt/c/…` legacy
 * artifacts of one.
 *
 * `Users`/`Windows` is not decoration, it is the entire safety argument. `/c/dev` could
 * be a real directory on any machine, so it is left alone; a top-level single-letter
 * directory containing `Users` or `Windows` is, in practice, only ever Windows written
 * this way — which is why this one does not need to know whether it is looking at WSL,
 * unlike `/mnt/c`, whose name is unremarkable on any Linux box.
 */
const MSYS_DRIVE = /^\/([A-Za-z])\/(Users|Windows)(\/.*)?$/i

function unify(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Build the Windows spelling of a distro path: `\\wsl.localhost\<distro>\home\me\proj`. */
function toUnc(distro: string, posix: string): string {
  return `\\\\wsl.localhost\\${distro}${posix.replace(/\//g, '\\')}`
}

/**
 * The distro and Linux path behind a WSL share spelling, or null for anything else.
 *
 * The main process makes the same read when it spawns a terminal (`parseWslUnc` in
 * terminal.ts): a chat whose folder is `\\wsl.localhost\Ubuntu\home\me\proj` gets a
 * shell *inside* Ubuntu, because a Windows shell cannot cd into a UNC path. This is
 * that knowledge on the renderer side, so a chat created from the UNC spelling can be
 * recorded as the WSL chat it is going to be — rather than a local one whose terminal
 * quietly ends up somewhere else, with its transcript written on the far side of the
 * boundary where nothing here thinks to look for it.
 */
export function parseWslUnc(path: string): { distro: string; posixPath: string } | null {
  const m = unify(path).match(WSL_UNC)
  if (!m) return null
  return { distro: m[1], posixPath: m[2] || '/' }
}

/**
 * Resolve a path to the one spelling every session in that folder can be keyed by.
 *
 * For a WSL folder that is the UNC form, deliberately — not the POSIX one. It is the
 * spelling that works on both sides: Windows can open it directly, and `uncToWslPath`
 * in the main process already translates it back before anything runs inside the
 * distro. A group keyed on the POSIX path would hand `\home\me\proj` to a plain
 * Windows chat, which is not a place that exists.
 *
 * Anything that does not resolve — a POSIX path with no distro to attribute it to, an
 * unmapped drive letter, an ordinary Windows path — comes back untouched.
 */
export function canonicalProjectPath(
  path: string,
  wslDistro?: string,
  ctx: ProjectKeyContext = {}
): string {
  const p = unify(path)
  if (!p) return path

  const unc = p.match(WSL_UNC)
  if (unc) return toUnc(unc[1], unc[2] ?? '')

  const drive = p.match(DRIVE)
  if (drive) {
    const distro = ctx.driveMap?.[drive[1].toLowerCase()]
    return distro ? toUnc(distro, drive[2] ?? '') : path
  }

  if (p.startsWith('/')) {
    // Checked before the distro is looked up, because this shape carries its own
    // evidence: whoever wrote it — Git Bash, or a WSL session recording a mount — was
    // naming a Windows folder, and it belongs with the chats that spell it `C:\Users\…`.
    const msys = p.match(MSYS_DRIVE)
    if (msys) {
      return `${msys[1].toUpperCase()}:\\${msys[2]}${(msys[3] ?? '').replace(/\//g, '\\')}`
    }

    const distro = wslDistro ?? ctx.posixDistros?.get(p.toLowerCase())
    if (!distro) return path
    // Inside a distro, /mnt/c is not a folder in that distro at all — it is the Windows
    // C: drive, reached through the mount. So it belongs with the Windows chats working
    // in the same place, not under a \\wsl.localhost heading of its own. Requiring the
    // distro to be known is what makes this safe: on a plain Linux host reached over
    // SSH, /mnt/c really is just a mount point, and nothing here should touch it.
    const mnt = p.match(MNT_DRIVE)
    if (mnt) return `${mnt[1].toUpperCase()}:${(mnt[2] ?? '/').replace(/\//g, '\\')}`
    return toUnc(distro, p)
  }

  return path
}

export function projectKey(
  path: string,
  wslDistro?: string,
  ctx?: ProjectKeyContext
): string {
  return unify(canonicalProjectPath(path, wslDistro, ctx)).toLowerCase()
}

/**
 * The key a path had before WSL addresses were folded together — still needed for
 * reading, because a custom project name the user set back then is filed under it.
 */
export function legacyProjectKey(path: string): string {
  return unify(path).toLowerCase()
}

/**
 * Map each POSIX project path to the distro it belongs to, learnt from the sessions
 * that record both. A path claimed by two different distros is left out rather than
 * guessed at: merging two folders that are not the same one is worse than leaving a
 * group split.
 */
export function buildPosixDistroMap(
  sessions: { projectPath?: string; wslDistro?: string }[]
): Map<string, string> {
  const seen = new Map<string, string | null>()
  for (const s of sessions) {
    if (!s.projectPath || !s.wslDistro) continue
    const p = unify(s.projectPath)
    if (!p.startsWith('/')) continue
    const key = p.toLowerCase()
    const prev = seen.get(key)
    if (prev === undefined) seen.set(key, s.wslDistro)
    else if (prev !== null && prev.toLowerCase() !== s.wslDistro.toLowerCase()) seen.set(key, null)
  }
  const out = new Map<string, string>()
  for (const [key, distro] of seen) if (distro) out.set(key, distro)
  return out
}
