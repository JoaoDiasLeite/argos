/**
 * Line formatting for the updater log (see updater-log.ts). electron-updater hands its
 * logger strings most of the time, but errors arrive as Error objects and a few calls
 * pass extra values — all of it has to end up on one readable, timestamped line.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** `2026-09-24T10:00:00.000Z [info] message` — a multi-line stack stays indented under it. */
export function formatLogLine(level: LogLevel, args: unknown[], at: Date): string {
  const text = args.map(describe).join(' ')
  return `${at.toISOString()} [${level}] ${text.replace(/\r?\n/g, '\n    ')}\n`
}
