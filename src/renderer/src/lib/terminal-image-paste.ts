import type { ProviderId } from '../types'

/**
 * Where an image on the clipboard should go when it is pasted into a terminal.
 *
 * Two ways exist, and which one is right depends on whether the CLI on the far side of
 * the pty can reach the clipboard itself:
 *
 * - **It attaches the picture properly** when it can — the transcript shows
 *   `[Image #1]`. Handing it a file path instead works, in the sense that the path is
 *   correct, and is plainly worse to use.
 * - **Argos writes the file** when it cannot, into somewhere the CLI can open, and types
 *   that path at the prompt.
 *
 * Kept apart from the terminal so the rule can be read and tested on its own: it took a
 * wrong premise about WSL to make every distro take the second path.
 */
export type ImagePasteRoute =
  /** Hand the gesture to the CLI as its own Alt+V; it reads the clipboard. */
  | 'cli-clipboard'
  /** Write the image out and paste the path (see `clipboard:image-to-file`). */
  | 'file'
  /** Neither is possible — do nothing. */
  | 'refuse'

export interface ImagePasteEnv {
  /** The distro this terminal runs in, if any. */
  wslDistro?: string
  /** The SSH host this terminal runs on, if any. */
  remoteHostId?: string
  /** Which CLI is running in it. */
  provider?: ProviderId
  /**
   * Whether a CLI is running in this terminal at all. A plain shell (a Remote Session
   * pane, a terminal whose CLI has been quit) has nobody to hand the gesture to, and a
   * path it can `cat` is the only thing an image can usefully become there.
   */
  cliRunning: boolean
  /**
   * Whether that distro's CLI can read the clipboard image itself — `wslClipboardImageCapable`,
   * asked when the terminal opens. `null` while it has not answered yet.
   */
  distroReadsClipboard: boolean | null
}

export function imagePasteRoute(env: ImagePasteEnv): ImagePasteRoute {
  // SSH gets neither: the file would be written here and the shell is there, and a path
  // that silently points at nothing is worse than doing nothing at all.
  if (env.remoteHostId) return 'refuse'

  // No CLI, no reader — whatever the shell is, it gets a path.
  if (!env.cliRunning) return 'file'

  // Local: the CLI and the clipboard are on the same machine, so it always wins.
  if (!env.wslDistro) return 'cli-clipboard'

  // In a distro it depends on what is installed over there — wl-paste, xclip, or Windows
  // interop. Unanswered (null) counts as no: the file path always works, and a wrong yes
  // costs the picture, since the CLI answers "no image in clipboard found" and there is
  // nothing left to fall back from.
  if (env.distroReadsClipboard !== true) return 'file'

  // The probe answers for Claude Code's readers, which is where its list was read from.
  // Codex and Gemini are not known to try the same ones, so they keep the path they can
  // certainly open rather than a gesture that might land nowhere.
  return !env.provider || env.provider === 'claude' ? 'cli-clipboard' : 'file'
}
