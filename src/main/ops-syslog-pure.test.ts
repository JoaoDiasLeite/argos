import { describe, it, expect } from 'vitest'
import { parseSimpleCommand, shellJoin } from './ops-gate-pure'
import {
  LOGGER_PROBE_ARGV,
  SYSLOG_MAX_BYTES,
  loggerArgv,
  loggerFailureReason,
  loggerMissingReason,
  sanitizeSyslogText,
  syslogMessage,
  syslogPriority,
  syslogValue,
  type SyslogCall,
  type SyslogRunInfo
} from './ops-syslog-pure'

const RUN: SyslogRunInfo = { intervention: 'run-1', runbook: 'update-wmcp', operator: 'JoãoLeite', host: 'Rocky-9-Testes', user: 'wiremaze' }

const cmd = (argv: string[], extra: Partial<SyslogCall> = {}): SyslogCall => ({
  callId: 'run-1-3',
  tool: 'run',
  class: 'read',
  approval: 'auto',
  target: { kind: 'cmd', argv },
  ...extra
})

const done = (exitCode: number | null, extra = {}) => ({ event: 'end' as const, result: { ok: true, exitCode, timedOut: false, durationMs: 1234, ...extra } })

/** The value of `key` in a message, unquoted, as a logfmt reader would take it. */
function field(msg: string, key: string): string | undefined {
  const m = new RegExp(`(?:^| )${key}=("(?:[^"\\\\]|\\\\.)*"|\\S*)`).exec(msg)
  if (!m) return undefined
  const v = m[1]
  return v.startsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v
}

describe('syslog message', () => {
  it('lists who, where and what as key=value, in a fixed order', () => {
    const msg = syslogMessage(
      RUN,
      {
        callId: 'run-1-7',
        tool: 'script',
        class: 'mutate',
        approval: 'ask',
        approvedBy: 'JoãoLeite',
        title: 'Atualização: execução de um passo da atualização',
        target: { kind: 'script', name: 'wmcp-step.sh', sha256: 'ab'.repeat(32), args: ['test_rails'] }
      },
      { event: 'start' }
    )
    expect(msg).toBe(
      'intervention=run-1 runbook=update-wmcp event=start call=run-1-7 operator="JoãoLeite" host=Rocky-9-Testes user=wiremaze ' +
        'tool=script class=mutate approval=ask approved_by="JoãoLeite" rule="Atualização: execução de um passo da atualização" ' +
        `script=wmcp-step.sh sha256=${'ab'.repeat(32)} args=test_rails`
    )
  })

  it('gives a command its canonical form, and leaves approved_by out of an auto call', () => {
    const msg = syslogMessage(RUN, cmd(['systemctl', 'status', 'puma 2'], { approvedBy: 'x' }), { event: 'start' })
    expect(field(msg, 'cmd')).toBe("systemctl status 'puma 2'")
    expect(msg).not.toContain('approved_by')
  })

  it('a write names the path and the content hash, never the content', () => {
    const msg = syslogMessage(RUN, { ...cmd([]), tool: 'write', class: 'mutate', target: { kind: 'write', path: '/etc/app.conf', sha256: 'f'.repeat(64) } }, { event: 'start' })
    expect(field(msg, 'path')).toBe('/etc/app.conf')
    expect(field(msg, 'sha256')).toBe('f'.repeat(64))
    expect(msg).not.toContain('cmd=')
  })

  it('end carries the exit code and duration; a timeout says so instead', () => {
    expect(syslogMessage(RUN, cmd(['uptime']), done(0))).toContain('event=end exit=0 duration_ms=1234 call=')
    expect(syslogMessage(RUN, cmd(['false']), done(1))).toContain('event=end exit=1 duration_ms=1234')
    const t = syslogMessage(RUN, cmd(['sleep', '900']), { event: 'end', result: { ok: true, exitCode: null, timedOut: true, durationMs: 600000 } })
    expect(t).toContain('event=timeout duration_ms=600000 call=')
    expect(t).not.toContain('exit=')
  })

  it('end of a command that did not run to its end names why', () => {
    const msg = syslogMessage(RUN, cmd(['uptime']), { event: 'end', result: { ok: false, exitCode: null, timedOut: false, durationMs: 5, error: 'aborted' } })
    expect(msg).toContain('event=end exit=none duration_ms=5 error=aborted')
  })

  it('upload and remove name the file in ~/.argos-ops', () => {
    const msg = syslogMessage(RUN, cmd(['x']), { event: 'upload', file: '/home/wiremaze/.argos-ops/0a1b/wmcp-step.sh' })
    expect(msg).toContain('event=upload file=/home/wiremaze/.argos-ops/0a1b/wmcp-step.sh call=')
  })
})

describe('syslog value quoting', () => {
  it('keeps plain words bare and double-quotes the rest, escaping quotes and backslashes', () => {
    expect(syslogValue('test_rails')).toBe('test_rails')
    expect(syslogValue('--lane=current')).toBe('--lane=current')
    expect(syslogValue('')).toBe('""')
    expect(syslogValue('a b')).toBe('"a b"')
    expect(syslogValue(`say "hi" it's`)).toBe(`"say \\"hi\\" it's"`)
    expect(syslogValue('C:\\path')).toBe('"C:\\\\path"')
  })

  it('leaves $ and backticks as text: nothing here is a shell line', () => {
    const msg = syslogMessage(RUN, cmd(['echo', '$HOME', '`id`', '$(rm -rf /)']), { event: 'start' })
    expect(field(msg, 'cmd')).toBe("echo '$HOME' '`id`' '$(rm -rf /)'")
  })

  it('turns control characters and line breaks into spaces, so one call is one line', () => {
    expect(sanitizeSyslogText('a\nb\r\nc\td\u0000e\u001bf\u007fg\u0085h\u2028i')).toBe('a b c d e f g h i')
    const msg = syslogMessage(RUN, cmd(['printf', 'one\ntwo']), { event: 'start' })
    expect(msg).not.toMatch(/[\n\r]/)
    expect(field(msg, 'cmd')).toBe("printf 'one two'")
  })

  it('keeps unicode as it is', () => {
    const msg = syslogMessage(RUN, cmd(['grep', 'Atualização', '/var/log/app.log']), { event: 'start' })
    // The canonical form quotes a non-ASCII word; the characters themselves stay.
    expect(field(msg, 'cmd')).toBe("grep 'Atualização' /var/log/app.log")
    expect(field(msg, 'operator')).toBe('JoãoLeite')
  })
})

describe('syslog message length', () => {
  it('cuts a long command to the limit, keeps the end fields, and says it was cut', () => {
    const long = Array.from({ length: 400 }, (_, i) => `arg${i}`)
    const msg = syslogMessage(RUN, cmd(['echo', ...long]), done(0))
    expect(Buffer.byteLength(msg, 'utf-8')).toBeLessThanOrEqual(SYSLOG_MAX_BYTES)
    expect(msg.endsWith(' truncated=true')).toBe(true)
    expect(msg).toContain('event=end exit=0 duration_ms=1234')
    // The cut value is closed, so the message still reads as key=value pairs.
    expect(field(msg, 'cmd')).toMatch(/^echo arg0 arg1 .*…$/)
  })

  it('counts bytes, so a long unicode value never splits a character', () => {
    const msg = syslogMessage(RUN, cmd(['echo', 'ção'.repeat(600)]), { event: 'start' })
    expect(Buffer.byteLength(msg, 'utf-8')).toBeLessThanOrEqual(SYSLOG_MAX_BYTES)
    expect(msg).not.toContain('\ufffd')
    expect(Buffer.from(msg, 'utf-8').toString('utf-8')).toBe(msg)
    expect(msg.endsWith(' truncated=true')).toBe(true)
  })

  it('does not leave an escaping backslash before the closing quote', () => {
    const msg = syslogMessage(RUN, cmd(['echo', '\\'.repeat(2000)]), { event: 'start' })
    expect(Buffer.byteLength(msg, 'utf-8')).toBeLessThanOrEqual(SYSLOG_MAX_BYTES)
    expect(field(msg, 'cmd')).toMatch(/…$/)
  })

  it('leaves a message under the limit untouched', () => {
    expect(syslogMessage(RUN, cmd(['uptime']), { event: 'start' })).not.toContain('truncated')
  })
})

describe('logger exec', () => {
  it('passes the message as one word after --, which the quoting keeps whole', () => {
    const msg = syslogMessage(RUN, cmd(['echo', `it's "$x"`, 'a\nb', '-p']), { event: 'start' })
    const argv = loggerArgv('user.notice', msg)
    expect(argv).toEqual(['logger', '-t', 'argos', '-p', 'user.notice', '--', msg])
    // What the executor sends parses back to the same words: the message is never split or expanded.
    expect(parseSimpleCommand(shellJoin(argv))).toEqual({ ok: true, argv })
  })

  it('logs a clean start or end at notice and anything else at err', () => {
    expect(syslogPriority({ event: 'start' })).toBe('user.notice')
    expect(syslogPriority({ event: 'upload', file: '/x' })).toBe('user.notice')
    expect(syslogPriority(done(0))).toBe('user.notice')
    expect(syslogPriority(done(2))).toBe('user.err')
    expect(syslogPriority({ event: 'end', result: { ok: true, exitCode: null, timedOut: true, durationMs: 1 } })).toBe('user.err')
    expect(syslogPriority({ event: 'end', result: { ok: false, exitCode: null, timedOut: false, durationMs: 1, error: 'x' } })).toBe('user.err')
  })

  it('reads the probe and a failed logger as reasons for the report', () => {
    expect(LOGGER_PROBE_ARGV).toEqual(['command', '-v', 'logger'])
    expect(loggerMissingReason({ ok: true, exitCode: 0 })).toBeNull()
    expect(loggerMissingReason({ ok: true, exitCode: 1 })).toBe('logger is not installed on the host')
    expect(loggerMissingReason({ ok: false, exitCode: null, error: 'connection closed' })).toBe('could not check for logger: connection closed')
    expect(loggerFailureReason({ ok: true, exitCode: 0, timedOut: false, stderr: '' })).toBeNull()
    expect(loggerFailureReason({ ok: true, exitCode: 1, timedOut: false, stderr: 'logger: socket /dev/log: No such file\n' })).toBe(
      'logger exited 1: logger: socket /dev/log: No such file'
    )
    expect(loggerFailureReason({ ok: true, exitCode: null, timedOut: true, stderr: '' })).toBe('logger timed out')
  })
})
