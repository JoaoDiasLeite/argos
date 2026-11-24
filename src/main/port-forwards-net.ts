import * as net from 'net'
import type { Duplex } from 'stream'
import { listenOptions } from './port-forwards-pure'

/**
 * The listener behind one tunnel, apart from ssh2 and electron so it can be tested in
 * process: it takes the connection's `forwardOut` as a function. Every accepted socket gets
 * its own channel; a socket or channel that fails is closed on its own and the listener
 * keeps serving the others.
 */

/** ssh2's `Client.forwardOut`, bound to one connection. */
export type ForwardOut = (
  srcIP: string,
  srcPort: number,
  dstIP: string,
  dstPort: number,
  cb: (err: Error | undefined, channel: Duplex) => void
) => void

export interface ForwardListenerOptions {
  localPort: number
  remoteHost: string
  remotePort: number
  forwardOut: ForwardOut
  /** The number of live connections changed. */
  onConnections?: (n: number) => void
  /** A channel opened (`undefined`) or the server refused one (its message). */
  onChannel?: (error: string | undefined) => void
}

export interface ForwardListener {
  /** The port it listens on (the one picked when asked for 0). */
  port: number
  /** The address it is bound to: always LISTEN_HOST (asserted by the tests). */
  address: string
  /** Stops listening and ends every connection still open. Safe to call twice. */
  close(): void
}

export type ListenResult = { ok: true; listener: ForwardListener } | { ok: false; code?: string; message: string }

function destroyQuietly(s: { destroy(): unknown } | undefined): void {
  try {
    s?.destroy()
  } catch {
    // Already gone.
  }
}

export function openForwardListener(opts: ForwardListenerOptions): Promise<ListenResult> {
  const live = new Set<net.Socket>()
  const channels = new Set<Duplex>()
  let closed = false
  const changed = () => opts.onConnections?.(live.size)

  const server = net.createServer((socket) => {
    if (closed) {
      socket.destroy()
      return
    }
    live.add(socket)
    changed()
    let channel: Duplex | undefined
    const finish = () => {
      if (!live.delete(socket)) return
      destroyQuietly(channel)
      destroyQuietly(socket)
      changed()
    }
    // An unhandled 'error' on either end would take the whole main process down.
    socket.on('error', finish)
    socket.on('close', finish)
    // The socket stays paused (no 'data' listener yet) until the channel exists, so what
    // the client sends first is buffered rather than lost.
    try {
      opts.forwardOut('127.0.0.1', socket.remotePort ?? 0, opts.remoteHost, opts.remotePort, (err, ch) => {
        if (err) {
          opts.onChannel?.(err.message)
          finish()
          return
        }
        if (!live.has(socket)) {
          destroyQuietly(ch)
          return
        }
        channel = ch
        channels.add(ch)
        opts.onChannel?.(undefined)
        ch.on('error', finish)
        ch.on('close', () => {
          channels.delete(ch)
          finish()
        })
        socket.pipe(ch).pipe(socket)
      })
    } catch (e) {
      // ssh2 throws at once on a connection that is no longer usable.
      opts.onChannel?.(e instanceof Error ? e.message : String(e))
      finish()
    }
  })

  const close = () => {
    if (closed) return
    closed = true
    try {
      server.close()
    } catch {
      // Not listening.
    }
    // server.close() only stops new connections: the ones piping would carry on.
    for (const s of [...live]) destroyQuietly(s)
    for (const c of [...channels]) destroyQuietly(c)
    live.clear()
    channels.clear()
  }

  return new Promise((resolve) => {
    let settled = false
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      closed = true
      resolve({ ok: false, code: e.code, message: e.message })
    })
    server.once('listening', () => {
      if (settled) return
      settled = true
      // After listening, a server error (rare) closes the tunnel rather than crashing.
      server.on('error', close)
      const addr = server.address()
      const port = addr && typeof addr === 'object' ? addr.port : opts.localPort
      const address = addr && typeof addr === 'object' ? addr.address : ''
      resolve({ ok: true, listener: { port, address, close } })
    })
    server.listen(listenOptions(opts.localPort))
  })
}

