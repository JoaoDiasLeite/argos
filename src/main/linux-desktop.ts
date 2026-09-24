import { spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { terminalCandidates } from './linux-desktop-pure'

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

function onPath(bin: string): boolean {
  if (bin.includes('/')) return isExecutable(bin)
  return (process.env.PATH || '').split(':').some((dir) => dir && isExecutable(path.join(dir, bin)))
}

/**
 * Open `script` in a new terminal window on Linux. Returns false when no known
 * terminal emulator is installed, so the caller reports the login as not launched and
 * the UI's manual command is the way forward. The check is done up front because a
 * spawn of a missing binary only fails asynchronously, after we'd have said it worked.
 */
export function openLinuxTerminal(script: string): boolean {
  const pick = terminalCandidates(script, process.env.TERMINAL).find((c) => onPath(c.bin))
  if (!pick) return false
  const child = spawn(pick.bin, pick.args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {
    /* found on PATH but failed to start — nothing more to do */
  })
  child.unref()
  return true
}
