import { describe, it, expect } from 'vitest'
import { anySignal, backupPathFor, createExecutor, makeCapture, makeHostQueue, type ExecOpts } from './ops-exec-pure'
import { createFakeBackend } from './ops-backend-fake'

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

function opts(over: Partial<ExecOpts> = {}): ExecOpts {
  return { timeoutMs: 1000, maxOutputBytes: 1000, signal: new AbortController().signal, ...over }
}

describe('makeCapture', () => {
  it('keeps everything under the cap', () => {
    const c = makeCapture(10)
    c.push(Buffer.from('abc'))
    c.push('def')
    expect(c.text()).toBe('abcdef')
    expect(c.bytes).toBe(6)
    expect(c.truncated).toBe(false)
  })

  it('stops keeping at the cap but keeps counting, and says how much was dropped', () => {
    const c = makeCapture(4)
    c.push(Buffer.from('abc'))
    c.push(Buffer.from('defgh'))
    c.push(Buffer.from('ij'))
    expect(c.bytes).toBe(10)
    expect(c.truncated).toBe(true)
    expect(c.text()).toBe('abcd\n[truncated 6 bytes]')
  })

  it('counts bytes, not characters', () => {
    const c = makeCapture(100)
    c.push('ção')
    expect(c.bytes).toBe(5)
  })

  it('a zero cap keeps nothing', () => {
    const c = makeCapture(0)
    c.push('x')
    expect(c.text()).toBe('\n[truncated 1 bytes]')
  })
})

describe('backupPathFor', () => {
  it('names the backup beside the file with a colon-free ISO time', () => {
    const p = backupPathFor('/etc/nginx/sites-available/app.conf', new Date('2026-10-01T09:08:07.006Z'))
    expect(p).toBe('/etc/nginx/sites-available/app.conf.argos-2026-10-01T09-08-07.006Z.bak')
    expect(p).not.toContain(':')
  })
})

describe('makeHostQueue', () => {
  it('runs two calls on one host in order and never at the same time', async () => {
    const q = makeHostQueue()
    const log: string[] = []
    let active = 0
    let maxActive = 0
    const job = (name: string, ms: number) => async () => {
      active++
      maxActive = Math.max(maxActive, active)
      log.push(`${name}:start`)
      await tick(ms)
      log.push(`${name}:end`)
      active--
      return name
    }
    const a = q.run('h1', job('a', 20))
    const b = q.run('h1', job('b', 1))
    expect(q.queuedBehind('h1')).toBe(2)
    expect(await Promise.all([a, b])).toEqual(['a', 'b'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end'])
    expect(maxActive).toBe(1)
    expect(q.queuedBehind('h1')).toBe(0)
  })

  it('lets calls on two hosts interleave', async () => {
    const q = makeHostQueue()
    const log: string[] = []
    const job = (name: string, ms: number) => async () => {
      log.push(`${name}:start`)
      await tick(ms)
      log.push(`${name}:end`)
    }
    await Promise.all([q.run('h1', job('a', 20)), q.run('h2', job('b', 1))])
    expect(log).toEqual(['a:start', 'b:start', 'b:end', 'a:end'])
  })

  it('a rejected call does not block the next one on that host', async () => {
    const q = makeHostQueue()
    const failing = q.run('h1', async () => {
      throw new Error('boom')
    })
    const next = q.run('h1', async () => 'ran')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ran')
    expect(q.queuedBehind('h1')).toBe(0)
  })

  it('a synchronous throw is a rejection, not a stuck queue', async () => {
    const q = makeHostQueue()
    const bad = q.run('h1', (() => {
      throw new Error('sync')
    }) as () => Promise<void>)
    await expect(bad).rejects.toThrow('sync')
    expect(await q.run('h1', async () => 1)).toBe(1)
  })
})

describe('anySignal', () => {
  it('aborts when any input aborts and detaches on dispose', () => {
    const a = new AbortController()
    const b = new AbortController()
    const linked = anySignal([a.signal, b.signal])
    b.abort('why')
    expect(linked.signal.aborted).toBe(true)
    const again = anySignal([a.signal])
    again.dispose()
    a.abort()
    expect(again.signal.aborted).toBe(false)
  })
})

describe('createExecutor', () => {
  it('abortAll ends an in-flight exec, and later calls still run', async () => {
    const fake = createFakeBackend({ delayMs: 200 })
    const ex = createExecutor(fake)
    const pending = ex.run('h1', () => ex.backend.exec('h1', ['uptime'], opts()))
    await tick(10)
    ex.abortAll()
    const r = await pending
    expect(r.ok).toBe(false)
    expect(r.error).toBe('aborted')

    const quick = createExecutor(createFakeBackend())
    quick.abortAll()
    const after = await quick.run('h1', () => quick.backend.exec('h1', ['uptime'], opts()))
    expect(after).toMatchObject({ ok: true, exitCode: 0, stdout: 'ok' })
  })

  it('serialises through run and reports how many are queued', async () => {
    const ex = createExecutor(createFakeBackend({ delayMs: 20 }))
    const a = ex.run('h1', () => ex.backend.exec('h1', ['a'], opts()))
    const b = ex.run('h1', () => ex.backend.exec('h1', ['b'], opts()))
    expect(ex.queuedBehind('h1')).toBe(2)
    expect(ex.queuedBehind('h2')).toBe(0)
    await Promise.all([a, b])
    expect(ex.queuedBehind('h1')).toBe(0)
  })
})

describe('createFakeBackend', () => {
  it('records calls and returns exit 0 / ok by default', async () => {
    const fake = createFakeBackend()
    const r = await fake.exec('h1', ['systemctl', 'status', 'nginx'], opts({ stdin: 'pw\n' }))
    expect(r).toMatchObject({ ok: true, exitCode: 0, stdout: 'ok', stdoutBytes: 2, timedOut: false })
    expect(fake.calls).toEqual([
      { kind: 'exec', hostId: 'h1', args: { argv: ['systemctl', 'status', 'nginx'], stdin: 'pw\n', timeoutMs: 1000 } }
    ])
  })

  it('uses the scripted result and applies the output cap', async () => {
    const fake = createFakeBackend({ exec: (argv) => ({ exitCode: argv[0] === 'false' ? 1 : 0, stdout: 'x'.repeat(50) }) })
    const r = await fake.exec('h1', ['false'], opts({ maxOutputBytes: 10 }))
    expect(r.exitCode).toBe(1)
    expect(r.stdoutBytes).toBe(50)
    expect(r.truncated).toBe(true)
    expect(r.stdout).toBe('xxxxxxxxxx\n[truncated 40 bytes]')
  })

  it('turns a delay past the timeout into a timed-out result', async () => {
    const fake = createFakeBackend({ delayMs: 100 })
    const r = await fake.exec('h1', ['sleep', '9'], opts({ timeoutMs: 5 }))
    expect(r).toMatchObject({ ok: true, timedOut: true, exitCode: null })
  })

  it('reads, lists and writes with a backup', async () => {
    const fake = createFakeBackend({ files: { '/etc/app/a.conf': 'old', '/etc/app/sub/b': 'x', '/bin/blob': 'a\0b' } })
    expect(await fake.read('h1', '/etc/app/a.conf', 100)).toEqual({ ok: true, content: 'old' })
    expect(await fake.read('h1', '/etc/app/a.conf', 1)).toEqual({ ok: true, tooLarge: true })
    expect(await fake.read('h1', '/bin/blob', 100)).toEqual({ ok: true, binary: true })
    expect(await fake.read('h1', '/nope', 100)).toMatchObject({ ok: false })
    const l = await fake.list('h1', '/etc/app')
    expect(l.ok && l.entries.map((e) => `${e.name}:${e.type}`)).toEqual(['a.conf:file', 'sub:directory'])
    const w = await fake.write('h1', '/etc/app/a.conf', 'new', true)
    expect(w.ok && w.backupPath).toMatch(/^\/etc\/app\/a\.conf\.argos-.*\.bak$/)
    expect(w.ok && w.beforeSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fake.files['/etc/app/a.conf']).toBe('new')
    if (w.ok && w.backupPath) expect(fake.files[w.backupPath]).toBe('old')
  })

  it('runScript passes [name, ...args] to the scripted exec and records the hash', async () => {
    const seen: string[][] = []
    const fake = createFakeBackend({ exec: (argv) => (seen.push(argv), {}) })
    await fake.runScript('h1', 'reload.sh', Buffer.from('#!/bin/sh\n'), ['web-01'], opts())
    expect(seen).toEqual([['reload.sh', 'web-01']])
    expect(fake.calls[0]).toMatchObject({ kind: 'runScript', args: { name: 'reload.sh', args: ['web-01'] } })
  })

  it('reports unreachable hosts from the script', async () => {
    const fake = createFakeBackend({ reachable: { h2: false } })
    expect((await fake.reachable('h1', 100)).ok).toBe(true)
    expect((await fake.reachable('h2', 100)).ok).toBe(false)
  })
})
