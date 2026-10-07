import { describe, it, expect } from 'vitest'
import { ShellRegistry, type CreateResult, type CreateTicket } from './remote-shell-pure'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

type Chan = { name: string }

// Mirrors remote-shell.ts: wait for the "connection", then adopt the channel or report it
// should be closed.
function fakeRun(
  reg: ShellRegistry<Chan>,
  id: string,
  connected: Promise<void>,
  chan: Chan,
  closed: Chan[],
  opened?: Chan[]
): (ticket: CreateTicket) => Promise<CreateResult> {
  return async (ticket) => {
    await connected
    opened?.push(chan)
    if (!reg.adopt(id, ticket, chan)) {
      closed.push(chan)
      return { ok: false, error: 'killed' }
    }
    return { ok: true }
  }
}

describe('ShellRegistry', () => {
  it('registers the channel once the create finishes', async () => {
    const reg = new ShellRegistry<Chan>()
    const chan = { name: 'a' }
    const res = await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), chan, []))
    expect(res).toEqual({ ok: true })
    expect(reg.get('t1')).toBe(chan)
  })

  it('a kill during a pending create closes the channel when it opens instead of registering it', async () => {
    const reg = new ShellRegistry<Chan>()
    const conn = deferred<void>()
    const chan = { name: 'a' }
    const closed: Chan[] = []
    const p = reg.create('t1', fakeRun(reg, 't1', conn.promise, chan, closed))
    expect(reg.kill('t1')).toEqual({ kind: 'pending' })
    conn.resolve()
    expect(await p).toEqual({ ok: false, error: 'killed' })
    expect(closed).toEqual([chan])
    expect(reg.get('t1')).toBeUndefined()
  })

  it('a concurrent create for a pending id joins it rather than opening a second channel', async () => {
    const reg = new ShellRegistry<Chan>()
    const conn = deferred<void>()
    const opened: Chan[] = []
    const a = reg.create('t1', fakeRun(reg, 't1', conn.promise, { name: 'a' }, [], opened))
    const b = reg.create('t1', fakeRun(reg, 't1', conn.promise, { name: 'b' }, [], opened))
    conn.resolve()
    expect(await Promise.all([a, b])).toEqual([{ ok: true }, { ok: true }])
    expect(opened.map((c) => c.name)).toEqual(['a'])
    expect(reg.get('t1')?.name).toBe('a')
  })

  it('create for a live id resolves ok without running again', async () => {
    const reg = new ShellRegistry<Chan>()
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), { name: 'a' }, []))
    let ran = false
    const res = await reg.create('t1', async () => {
      ran = true
      return { ok: true }
    })
    expect(res).toEqual({ ok: true })
    expect(ran).toBe(false)
  })

  it('StrictMode sequence (create, kill, create) ends with exactly one live channel', async () => {
    const reg = new ShellRegistry<Chan>()
    const conn = deferred<void>()
    const closed: Chan[] = []
    const first = reg.create('t1', fakeRun(reg, 't1', conn.promise, { name: 'first' }, closed))
    reg.kill('t1')
    const second = reg.create('t1', fakeRun(reg, 't1', conn.promise, { name: 'second' }, closed))
    conn.resolve()
    expect(await first).toEqual({ ok: false, error: 'killed' })
    expect(await second).toEqual({ ok: true })
    expect(closed.map((c) => c.name)).toEqual(['first'])
    expect(reg.get('t1')?.name).toBe('second')
  })

  it('kill of a live id hands the channel back and frees the id', async () => {
    const reg = new ShellRegistry<Chan>()
    const chan = { name: 'a' }
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), chan, []))
    expect(reg.kill('t1')).toEqual({ kind: 'live', channel: chan })
    expect(reg.get('t1')).toBeUndefined()
    expect(reg.kill('t1')).toEqual({ kind: 'none' })
  })

  it('release reports only a channel that was still live', async () => {
    const reg = new ShellRegistry<Chan>()
    const a = { name: 'a' }
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), a, []))
    expect(reg.release('t1', a)).toBe(true)
    expect(reg.get('t1')).toBeUndefined()

    const b = { name: 'b' }
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), b, []))
    reg.kill('t1')
    expect(reg.release('t1', b)).toBe(false) // killed: its close must not report an exit

    const c = { name: 'c' }
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), c, []))
    expect(reg.release('t1', b)).toBe(false) // a stale close never drops the new owner
    expect(reg.get('t1')).toBe(c)
  })

  it('killAll returns live channels and cancels pending creates', async () => {
    const reg = new ShellRegistry<Chan>()
    const live = { name: 'live' }
    await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), live, []))
    const conn = deferred<void>()
    const closed: Chan[] = []
    const pending = reg.create('t2', fakeRun(reg, 't2', conn.promise, { name: 'pending' }, closed))
    expect(reg.killAll()).toEqual([live])
    conn.resolve()
    expect(await pending).toEqual({ ok: false, error: 'killed' })
    expect(closed.map((c) => c.name)).toEqual(['pending'])
    expect(reg.get('t1')).toBeUndefined()
    expect(reg.get('t2')).toBeUndefined()
  })

  it('a rejecting run resolves as a failure and frees the id', async () => {
    const reg = new ShellRegistry<Chan>()
    const res = await reg.create('t1', () => Promise.reject(new Error('boom')))
    expect(res).toEqual({ ok: false, error: 'boom' })
    let ran = false
    await reg.create('t1', async () => {
      ran = true
      return { ok: true }
    })
    expect(ran).toBe(true)
  })

  it('a finished create frees its pending slot so a later create runs', async () => {
    const reg = new ShellRegistry<Chan>()
    expect(await reg.create('t1', async () => ({ ok: false, error: 'no host' }))).toEqual({
      ok: false,
      error: 'no host'
    })
    expect(await reg.create('t1', fakeRun(reg, 't1', Promise.resolve(), { name: 'a' }, []))).toEqual({ ok: true })
  })
})
