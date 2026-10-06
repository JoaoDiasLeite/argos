/**
 * The line an ops call leaves in the host's own syslog. A command run over SSH without a
 * session never reaches the shell history, so without this the host keeps no trace of
 * what Argos ran there; the ledger on the operator's machine is the only record.
 *
 * Every execution logs `start` before it runs and `end` (or `timeout`) after, as a
 * separate `logger` exec on the same connection: the gated command itself is never
 * wrapped or changed. The message is one argv word, quoted by the executor's shellJoin
 * like every other word, never spliced into a shell line.
 *
 * The message is `key=value` pairs (logfmt) so `journalctl -t argos` can be filtered with
 * grep. It never carries the sudo password (nothing here is given it) or a written file's
 * content (only its path and sha256).
 */
import { canonicalCommand } from './ops-gate-pure'
import type { ExecResult } from './ops-exec-pure'
import type { OpsClass, OpsToolName } from './ops-types'

export const SYSLOG_TAG = 'argos'
/** The longest message, in UTF-8 bytes (so also in characters). logger's own default cap is 1 KiB. */
export const SYSLOG_MAX_BYTES = 1000
const TRUNCATED = ' truncated=true'

/** `command -v logger`, run once per host per intervention before the first line. */
export const LOGGER_PROBE_ARGV: readonly string[] = ['command', '-v', 'logger']

/** Who and where: the same for every line of one call. */
export interface SyslogRunInfo {
  /** The ops run id, the one the ledger and the report carry. */
  intervention: string
  runbook: string
  operator: string
  host: string
  /** The SSH user the command runs as. */
  user: string
}

export type SyslogTarget =
  | { kind: 'cmd'; argv: string[] }
  | { kind: 'script'; name: string; sha256: string; args: string[] }
  | { kind: 'write'; path: string; sha256: string }

export interface SyslogCall {
  callId: string
  tool: OpsToolName
  class: OpsClass
  /** The gate's decision: `ask` means the operator approved it before it ran. */
  approval: 'auto' | 'ask'
  /** Who approved an `ask`. */
  approvedBy?: string
  /** The matching rule's title. */
  title?: string
  target: SyslogTarget
}

export type SyslogEvent =
  | { event: 'start' }
  | { event: 'upload' | 'remove'; file: string }
  | { event: 'end'; result: Pick<ExecResult, 'ok' | 'exitCode' | 'timedOut' | 'durationMs' | 'error' | 'signal'> }

/** Control characters and line breaks (C0, DEL, C1, U+2028/2029) become one space. */
export function sanitizeSyslogText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
}

const BARE = /^[A-Za-z0-9_./:@%+,=-]+$/

/** A value bare when it is plain ASCII without spaces or quotes, double-quoted otherwise. */
export function syslogValue(v: string): string {
  const s = sanitizeSyslogText(v)
  return BARE.test(s) ? s : `"${s.replace(/["\\]/g, '\\$&')}"`
}

const bytes = (s: string): number => Buffer.byteLength(s, 'utf-8')

/** The longest prefix of `s` within `max` UTF-8 bytes, never splitting a code point. */
function fitBytes(s: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of s) {
    const b = bytes(ch)
    if (n + b > max) break
    out += ch
    n += b
  }
  return out
}

/** `key="value…"` cut to `room` bytes, or '' when not even a few characters fit. */
function cutPair(pair: string, room: number): string {
  const eq = pair.indexOf('=')
  const key = pair.slice(0, eq + 1)
  const raw = pair.slice(eq + 1)
  const inner = raw.startsWith('"') ? raw.slice(1, -1) : raw
  // Quotes and the ellipsis around what is kept.
  const avail = room - bytes(key) - 2 - bytes('…')
  if (avail < 4) return ''
  let kept = fitBytes(inner, avail)
  // An odd run of trailing backslashes would escape the closing quote.
  if (/(?:^|[^\\])(?:\\\\)*\\$/.test(kept)) kept = kept.slice(0, -1)
  return `${key}"${kept}…"`
}

function eventFields(ev: SyslogEvent): [string, string][] {
  switch (ev.event) {
    case 'start':
      return [['event', 'start']]
    case 'upload':
    case 'remove':
      return [
        ['event', ev.event],
        ['file', ev.file]
      ]
    case 'end': {
      const r = ev.result
      if (r.timedOut) return [['event', 'timeout'], ['duration_ms', String(r.durationMs)]]
      return [
        ['event', 'end'],
        ['exit', r.exitCode === null ? 'none' : String(r.exitCode)],
        ['duration_ms', String(r.durationMs)],
        ...(r.signal ? ([['signal', r.signal]] as [string, string][]) : []),
        ...(!r.ok && r.error ? ([['error', r.error]] as [string, string][]) : [])
      ]
    }
  }
}

function targetFields(t: SyslogTarget): [string, string][] {
  switch (t.kind) {
    case 'cmd':
      return [['cmd', canonicalCommand(t.argv)]]
    case 'script':
      return [
        ['script', t.name],
        ['sha256', t.sha256],
        ['args', canonicalCommand(t.args)]
      ]
    case 'write':
      return [
        ['path', t.path],
        ['sha256', t.sha256]
      ]
  }
}

/**
 * The message for one line. Who, where and what happened come first and the long values
 * (rule title, command, arguments) last, so a cut to SYSLOG_MAX_BYTES only ever shortens
 * the command, never the exit code. A cut message ends in `truncated=true`.
 */
export function syslogMessage(run: SyslogRunInfo, call: SyslogCall, ev: SyslogEvent): string {
  const fields: [string, string][] = [
    ['intervention', run.intervention],
    ['runbook', run.runbook],
    ...eventFields(ev),
    ['call', call.callId],
    ['operator', run.operator],
    ['host', run.host],
    ['user', run.user],
    ['tool', call.tool],
    ['class', call.class],
    ['approval', call.approval],
    ...(call.approval === 'ask' && call.approvedBy ? ([['approved_by', call.approvedBy]] as [string, string][]) : []),
    ...(call.title ? ([['rule', call.title]] as [string, string][]) : []),
    ...targetFields(call.target)
  ]
  const pairs = fields.map(([k, v]) => `${k}=${syslogValue(v)}`)
  const full = pairs.join(' ')
  if (bytes(full) <= SYSLOG_MAX_BYTES) return full

  const budget = SYSLOG_MAX_BYTES - bytes(TRUNCATED)
  let out = ''
  for (const pair of pairs) {
    const sep = out ? ' ' : ''
    if (bytes(out + sep + pair) <= budget) {
      out += sep + pair
      continue
    }
    const cut = cutPair(pair, budget - bytes(out + sep))
    if (cut) out += sep + cut
    break
  }
  return out + TRUNCATED
}

/** user.err for a non-zero exit, a timeout or a command that did not run to its end. */
export function syslogPriority(ev: SyslogEvent): 'user.notice' | 'user.err' {
  if (ev.event !== 'end') return 'user.notice'
  const r = ev.result
  return !r.ok || r.timedOut || r.exitCode !== 0 ? 'user.err' : 'user.notice'
}

/** The logger exec, without sudo. `--` ends the options, so a message cannot pass for one. */
export function loggerArgv(priority: string, message: string): string[] {
  return ['logger', '-t', SYSLOG_TAG, '-p', priority, '--', message]
}

/** Why the host cannot take syslog lines, from the `command -v logger` probe; null when it can. */
export function loggerMissingReason(r: Pick<ExecResult, 'ok' | 'exitCode' | 'error'>): string | null {
  if (!r.ok) return `could not check for logger: ${r.error ?? 'the probe did not run'}`
  if (r.exitCode !== 0) return 'logger is not installed on the host'
  return null
}

/** Why a logger exec failed, or null when it wrote the line. */
export function loggerFailureReason(r: Pick<ExecResult, 'ok' | 'exitCode' | 'error' | 'timedOut' | 'stderr'>): string | null {
  if (!r.ok) return `logger did not run: ${r.error ?? 'unknown error'}`
  if (r.timedOut) return 'logger timed out'
  if (r.exitCode !== 0) {
    const err = sanitizeSyslogText(r.stderr ?? '').trim()
    return `logger exited ${r.exitCode ?? 'without a code'}${err ? `: ${err.slice(0, 200)}` : ''}`
  }
  return null
}
