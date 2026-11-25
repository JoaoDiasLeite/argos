import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { loginCommandScript } from './mac-terminal-pure'

const OPEN_TIMEOUT_MS = 15_000
// The script deletes itself when Terminal runs it; this is the backstop for a window
// that never ran it.
const CLEANUP_AFTER_MS = 10 * 60_000

function scriptDir(): string {
  const dir = path.join(os.tmpdir(), 'argos-login')
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function removeQuietly(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Open Terminal.app running `command` with `env` set, through a temporary `.command`
 * file and `open -a Terminal`. Resolves true only when `open` exited 0, so a failure is
 * reported to the UI (which then shows the manual command) instead of being swallowed.
 * macOS only.
 */
export function openMacTerminal(
  idForTempFile: string,
  command: string,
  env: Record<string, string>
): Promise<boolean> {
  let file: string
  try {
    const safeId = idForTempFile.replace(/[^A-Za-z0-9._-]/g, '_')
    file = path.join(scriptDir(), `${safeId}-${Date.now()}.command`)
    fs.writeFileSync(file, loginCommandScript({ command, env, path: process.env.PATH }), { mode: 0o700 })
    // writeFileSync's mode applies only on creation; make sure it is executable.
    fs.chmodSync(file, 0o700)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    execFile('/usr/bin/open', ['-a', 'Terminal', file], { timeout: OPEN_TIMEOUT_MS }, (err) => {
      if (err) {
        removeQuietly(file)
        resolve(false)
        return
      }
      setTimeout(() => removeQuietly(file), CLEANUP_AFTER_MS).unref()
      resolve(true)
    })
  })
}
