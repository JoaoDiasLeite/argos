import { app } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { unlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildExplorerMenuReg } from './explorer-menu-reg'

// Explorer "Open with Argos" context-menu entry.
//
// Electron has no registry API, so we drive reg.exe. Writing under HKCU (not HKLM)
// needs no elevation. All adds and deletes go into one .reg script applied with a single
// `reg import`, so a launch spawns one reg.exe (and its conhost) instead of eight.

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

/**
 * Whether an argv array carries `--toggle` (a bare flag, e.g. from a hotkey that
 * launches the exe). Only a second instance acts on it; a first launch opens as usual.
 */
export function hasToggleFlag(argv: string[]): boolean {
  return argv.includes('--toggle')
}

/**
 * Add (true) or remove (false) the Explorer folder context-menu entries, or leave them
 * alone (undefined), and optionally drop the pre-rename ClaudeGUI entries — all in one
 * reg.exe run. Never throws: the registry write is best-effort (locked key, policy).
 */
export async function syncExplorerContextMenu(
  enabled: boolean | undefined,
  opts: { removeLegacy?: boolean } = {}
): Promise<void> {
  const script = buildExplorerMenuReg({
    enabled,
    removeLegacy: opts.removeLegacy,
    command: launchCommand('--folder "%V"'),
    icon: process.execPath
  })
  if (!script) return
  const file = join(tmpdir(), `argos-explorer-menu-${randomUUID()}.reg`)
  try {
    // reg import reads UTF-16LE with a BOM, which keeps non-ASCII install paths intact.
    await writeFile(file, Buffer.from(`﻿${script}`, 'utf16le'))
    await new Promise<void>((resolve, reject) => {
      execFile('reg.exe', ['import', file], { windowsHide: true }, (err) =>
        err ? reject(err) : resolve()
      )
    })
  } catch {
    /* best-effort */
  } finally {
    await unlink(file).catch(() => {})
  }
}
