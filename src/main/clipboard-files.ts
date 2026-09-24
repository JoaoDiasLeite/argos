import { clipboard } from 'electron'
import { execFile } from 'child_process'

const TIMEOUT_MS = 5000

/**
 * The files on the clipboard — what Explorer's Copy leaves there — or an empty list.
 *
 * Electron has no reader for a file list. What it can read is `FileNameW`, the shell's
 * single-name format, which Explorer sets alongside the real list but which only ever
 * carries the first file. So it serves as the cheap "are there files at all?" check —
 * a paste with none must not pay for a spawn — and the whole list then comes from
 * .NET's `GetFileDropList` through PowerShell. Should that fail, the one name we
 * already have is still better than pasting nothing.
 *
 * Windows only: elsewhere the formats differ, and no terminal here has asked for them.
 */
export async function readClipboardFiles(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const first = clipboard.readBuffer('FileNameW').toString('ucs2').replace(/\0+$/, '').split('\0')[0]
  if (!first) return []

  const script =
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8; ' +
    'Add-Type -AssemblyName System.Windows.Forms; ' +
    '[System.Windows.Forms.Clipboard]::GetFileDropList()'
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => {
        const all = err ? [] : String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
        resolve(all.length ? all : [first])
      }
    )
  })
}
