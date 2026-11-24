import { describe, it, expect, afterEach, vi } from 'vitest'
import * as net from 'net'
import { PassThrough, Duplex } from 'stream'
import { openForwardListener, type ForwardListener, type ForwardOut } from './port-forwards-net'

/** A channel that echoes what it is sent, like a server's echo service at the far end. */
function echoChannel(): Duplex {
  const p = new PassThrough()
  return p
}

const open: ForwardListener[] = []
afterEach(() => {
  for (const l of open.splice(0)) l.close()
})

async function listen(forwardOut: ForwardOut, extra: Partial<Parameters<typeof openForwardListener>[0]> = {}) {
  const res = await openForwardListener({ localPort: 0, remoteHost: 'localhost', remotePort: 5432, forwardOut, ...extra })
  if (!res.ok) throw new Error(res.message)
  open.push(res.listener)
  return res.listener
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s))
    s.on('error', reject)
  })
}

function readOnce(s: net.Socket): Promise<string> {
  return new Promise((resolve) => s.once('data', (d) => resolve(d.toString())))
}

function closed(s: net.Socket): Promise<void> {
  return new Promise((resolve) => {
    if (s.destroyed) resolve()
    else s.once('close', () => resolve())
  })
}


describe('openForwardListener', () => {
  it('binds to 127.0.0.1 only, on a free port when asked for 0', async () => {
    const l = await listen((_a, _b, _c, _d, cb) => cb(undefined, echoChannel()))
    expect(l.address).toBe('127.0.0.1')
    expect(l.port).toBeGreaterThan(0)
  })

  it('opens a channel per connection to the remote target and pipes both ways', async () => {
    const calls: [string, number, string, number][] = []
    const l = await listen((srcIP, srcPort, dstIP, dstPort, cb) => {
      calls.push([srcIP, srcPort, dstIP, dstPort])
      cb(undefined, echoChannel())
    }, { remoteHost: 'db.internal', remotePort: 5433 })
    const s = await connect(l.port)
    const reply = readOnce(s)
    s.write('ping')
    expect(await reply).toBe('ping')
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('127.0.0.1')
    expect(calls[0].slice(2)).toEqual(['db.internal', 5433])
    s.destroy()
  })

  it('buffers what the client sends before the channel is open', async () => {
    const l = await listen((_a, _b, _c, _d, cb) => setTimeout(() => cb(undefined, echoChannel()), 50))
    const s = await connect(l.port)
    const reply = readOnce(s)
    s.write('early')
    expect(await reply).toBe('early')
    s.destroy()
  })

  it('counts live connections', async () => {
    const counts: number[] = []
    const l = await listen((_a, _b, _c, _d, cb) => cb(undefined, echoChannel()), { onConnections: (n) => counts.push(n) })
    const a = await connect(l.port)
    const b = await connect(l.port)
    await vi.waitFor(() => expect(counts.at(-1)).toBe(2))
    a.destroy()
    await vi.waitFor(() => expect(counts.at(-1)).toBe(1))
    b.destroy()
    await vi.waitFor(() => expect(counts.at(-1)).toBe(0))
  })

  it('closes only the refused connection and keeps serving', async () => {
    const reported: (string | undefined)[] = []
    let refuse = true
    const l = await listen(
      (_a, _b, _c, _d, cb) => {
        if (refuse) cb(new Error('Connection refused'), undefined as unknown as Duplex)
        else cb(undefined, echoChannel())
      },
      { onChannel: (e) => reported.push(e) }
    )
    const bad = await connect(l.port)
    await closed(bad)
    expect(reported).toEqual(['Connection refused'])
    refuse = false
    const good = await connect(l.port)
    const reply = readOnce(good)
    good.write('still here')
    expect(await reply).toBe('still here')
    expect(reported).toEqual(['Connection refused', undefined])
    good.destroy()
  })

  it('survives a forwardOut that throws and a channel that errors', async () => {
    let mode: 'throw' | 'error' | 'ok' = 'throw'
    const l = await listen((_a, _b, _c, _d, cb) => {
      if (mode === 'throw') throw new Error('Not connected')
      const ch = echoChannel()
      cb(undefined, ch)
      if (mode === 'error') setTimeout(() => ch.destroy(new Error('channel broke')), 10)
    })
    await closed(await connect(l.port))
    mode = 'error'
    await closed(await connect(l.port))
    mode = 'ok'
    const s = await connect(l.port)
    const reply = readOnce(s)
    s.write('ok')
    expect(await reply).toBe('ok')
    s.destroy()
  })

  it('ends live connections and their channels on close', async () => {
    const channels: Duplex[] = []
    const l = await listen((_a, _b, _c, _d, cb) => {
      const ch = echoChannel()
      channels.push(ch)
      cb(undefined, ch)
    })
    const s = await connect(l.port)
    await vi.waitFor(() => expect(channels).toHaveLength(1))
    l.close()
    await closed(s)
    expect(channels[0].destroyed).toBe(true)
    await expect(connect(l.port)).rejects.toThrow()
    l.close()
  })

  it('reports a port already in use with its code', async () => {
    const first = await listen((_a, _b, _c, _d, cb) => cb(undefined, echoChannel()))
    const res = await openForwardListener({
      localPort: first.port,
      remoteHost: 'localhost',
      remotePort: 1,
      forwardOut: (_a, _b, _c, _d, cb) => cb(undefined, echoChannel())
    })
    expect(res).toMatchObject({ ok: false, code: 'EADDRINUSE' })
  })
})
