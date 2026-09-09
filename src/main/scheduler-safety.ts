import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

export function scheduledWorkingDirectory(projectPath?: string): string {
  if (!projectPath) return os.homedir()
  if (!path.isAbsolute(projectPath)) throw new Error('Routine project folder must be an absolute path. Edit the routine and choose a folder.')
  try {
    if (!fs.statSync(projectPath).isDirectory()) throw new Error('Not a directory')
    fs.accessSync(projectPath, fs.constants.R_OK)
    return projectPath
  } catch {
    throw new Error(`Routine project folder is unavailable: ${projectPath}. Restore the folder or edit the routine before running again.`)
  }
}

export function startupRunTime(run: { nextRunAt?: number; missedRunPolicy?: 'skip' | 'run-once' }, now: number, next: number): number {
  if (run.nextRunAt != null && run.nextRunAt <= now) return run.missedRunPolicy === 'run-once' ? now : next
  return run.nextRunAt ?? next
}
