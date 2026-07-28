import { app } from 'electron'
import { execFile } from 'child_process'

// Explorer "Open with Argos" context-menu entry.
//
// Electron has no registry API, so we drive reg.exe. Writing under HKCU (not HKLM)
// needs no elevation. Two keys cover both cases the user reaches from Explorer:
//   • Directory\shell\Argos          — right-clicking a folder icon
//   • Directory\Background\shell\Argos — right-clicking empty space *inside* a folder
// Each has a `command` subkey whose default value launches us with `--folder "%V"`,
// where Explorer substitutes %V with the folder path.

const BASE = 'HKCU\\Software\\Classes\\Directory'
const KEYS = [`${BASE}\\shell\\Argos`, `${BASE}\\Background\\shell\\Argos`]
// Keys written under the app's former name. Their `command` still points at the old exe, so
// they'd sit in the Explorer menu as a dead "Open with Claude GUI" entry — removed on startup.
const LEGACY_KEYS = [`${BASE}\\shell\\ClaudeGUI`, `${BASE}\\Background\\shell\\ClaudeGUI`]

// Run reg.exe with the arguments passed as a real argv array. Node escapes each
// element for CreateProcess, so a value like `"exe" --folder "%V"` (embedded quotes
// and a %V that must NOT be expanded) arrives verbatim — no manual \" escaping needed.
function reg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  })
}

/**
 * The command string Explorer runs. Packaged: just the exe + args. Dev: the exe is
 * electron.exe, which needs the app path as its first argument to boot our app.
 * `%V` is the folder Explorer clicked on.
 */
export function launchCommand(extraArgs: string): string {
  const exe = process.execPath
  const appArg = app.isPackaged ? '' : ` "${app.getAppPath()}"`
  return `"${exe}"${appArg} ${extraArgs}`
}

async function registerKey(key: string): Promise<void> {
  const exe = process.execPath
  await reg(['add', key, '/ve', '/d', 'Open with Argos', '/f'])
  await reg(['add', key, '/v', 'Icon', '/d', exe, '/f'])
  await reg(['add', `${key}\\command`, '/ve', '/d', launchCommand('--folder "%V"'), '/f'])
}

async function deleteKey(key: string): Promise<void> {
  // Absent key → reg.exe exits non-zero; that's fine when we're removing.
  try {
    await reg(['delete', key, '/f'])
  } catch {
    /* key wasn't there — nothing to remove */
  }
}

export type LaunchAction = { type: 'folder'; path: string } | { type: 'new-chat' }

/**
 * Parse a launch action from an argv array (process.argv on first launch, or the
 * `commandLine` of a second-instance event). `--folder` takes the next arg as the
 * path (a single argv entry even with spaces); `--new-chat` is a bare flag.
 * Returns null when neither is present.
 */
export function extractLaunchAction(argv: string[]): LaunchAction | null {
  const folderIdx = argv.indexOf('--folder')
  if (folderIdx !== -1 && argv[folderIdx + 1]) {
    return { type: 'folder', path: argv[folderIdx + 1] }
  }
  if (argv.includes('--new-chat')) return { type: 'new-chat' }
  return null
}

/** Add or remove the Explorer folder context-menu entries. Never throws. */
export async function setExplorerContextMenu(enabled: boolean): Promise<void> {
  try {
    for (const key of KEYS) {
      if (enabled) await registerKey(key)
      else await deleteKey(key)
    }
  } catch {
    /* registry write failed (locked/policy) — the toggle is best-effort */
  }
}

/** Drop the pre-rename entries, whether or not the user has the menu enabled. Never throws. */
export async function removeLegacyExplorerContextMenu(): Promise<void> {
  try {
    for (const key of LEGACY_KEYS) await deleteKey(key)
  } catch {
    /* best-effort cleanup */
  }
}
