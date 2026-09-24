import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { formatLogLine, LogLevel } from './updater-log-pure'

// Past this the current file becomes updater.old.log and a fresh one starts, so the
// log never holds more than two files' worth. A check every four hours writes a few
// lines, so 1 MB is months of history.
const MAX_BYTES = 1024 * 1024

/** <userData>/logs/updater.log — next to sessions/ and config, where a user can find it. */
export function updaterLogPath(): string {
  return path.join(app.getPath('userData'), 'logs', 'updater.log')
}

function write(level: LogLevel, args: unknown[]): void {
  try {
    const file = updaterLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
      if (fs.statSync(file).size > MAX_BYTES) {
        fs.renameSync(file, file.replace(/\.log$/, '.old.log'))
      }
    } catch {
      /* no file yet — nothing to rotate */
    }
    fs.appendFileSync(file, formatLogLine(level, args, new Date()))
  } catch {
    /* logging must never be the thing that breaks an update */
  }
}

/**
 * The logger handed to electron-updater. Without one it logs to the console only,
 * which a packaged app has nowhere to show — a failed update left no trace at all.
 */
export const updaterLogger = {
  debug: (...args: unknown[]): void => write('debug', args),
  info: (...args: unknown[]): void => write('info', args),
  warn: (...args: unknown[]): void => write('warn', args),
  error: (...args: unknown[]): void => write('error', args)
}
