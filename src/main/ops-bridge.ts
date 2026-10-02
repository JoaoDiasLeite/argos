/**
 * The socket the `--ops-mcp` relay talks to (docs/OPS_AGENT_PLAN.md §9 Phase 5).
 *
 * One server per app, started on the first terminal ops session: a named pipe
 * `\\.\pipe\argos-ops-<random>` on Windows, a 0600 socket file
 * `<XDG_RUNTIME_DIR | socketDir>/argos-ops-<random>.sock` elsewhere. Each ops terminal
 * gets a fresh token, passed to its relay in the environment, and every message carries
 * it. The token names the session; an unknown one is dropped without a reply, and a
 * connection is bound to the first token it uses.
 *
 * The relay holds no policy. Every `call` runs here through the session's pipeline
 * (ops-session.ts `callOpsTool`): classify, log, ask, execute, log. If the relay were
 * tampered with, this side still gates.
 *
 * No Electron here: the socket folder and the sessions are handed in, so the test drives
 * it over a real pipe against the fake backend.
 */
import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import {
  bridgeEndpoint,
  createLineSplitter,
  encodeReply,
  isOpsToken,
  parseRequest,
  type OpsBridgeHello,
  type OpsBridgeReply,
  type OpsBridgeRequest
} from './ops-bridge-pure'

/** What a token resolves to: the terminal's ops session, seen through the two things the relay may ask. */
export interface OpsBridgeSession {
  hello(): OpsBridgeHello
  call(tool: string, args: Record<string, unknown> | undefined): Promise<{ text: string; isError: boolean }>
}

const sessions = new Map<string, OpsBridgeSession>()
let server: net.Server | null = null
let starting: Promise<{ endpoint: string }> | null = null
let endpointPath: string | null = null
const sockets = new Set<net.Socket>()

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Unix socket paths are short (≈104 bytes on macOS); a long fallback folder goes to the temp dir. */
function socketFolder(socketDir: string | undefined): string {
  const preferred = process.env.XDG_RUNTIME_DIR || socketDir || os.tmpdir()
  return preferred.length > 80 ? os.tmpdir() : preferred
}

/**
 * Start the bridge, or return the one already running. `socketDir` is the fallback
 * folder for the socket file when XDG_RUNTIME_DIR is unset (userData in the app);
 * ignored on Windows.
 */
export function startOpsBridge(opts: { socketDir?: string } = {}): Promise<{ endpoint: string }> {
  if (server && endpointPath) return Promise.resolve({ endpoint: endpointPath })
  if (starting) return starting
  starting = new Promise<{ endpoint: string }>((resolve, reject) => {
    const endpoint = bridgeEndpoint(process.platform, randomBytes(12).toString('hex'), socketFolder(opts.socketDir), path.join)
    if (process.platform !== 'win32') {
      try {
        fs.unlinkSync(endpoint)
      } catch {
        // none there: the usual case
      }
    }
    const s = net.createServer((socket) => serveConnection(socket))
    s.once('error', (e) => {
      starting = null
      reject(e)
    })
    s.listen(endpoint, () => {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(endpoint, 0o600)
        } catch {
          // The folder is the user's own (XDG_RUNTIME_DIR is 0700 by spec); the token still guards.
        }
      }
      server = s
      endpointPath = endpoint
      starting = null
      resolve({ endpoint })
    })
  })
  return starting
}

/** Stop the bridge and drop every connection. Tokens stay registered only in memory, so a restart starts clean. */
export async function stopOpsBridge(): Promise<void> {
  const s = server
  const ep = endpointPath
  server = null
  endpointPath = null
  for (const sock of sockets) sock.destroy()
  sockets.clear()
  sessions.clear()
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()))
  if (ep && process.platform !== 'win32') {
    try {
      fs.unlinkSync(ep)
    } catch {
      // already gone
    }
  }
}

export function registerToken(token: string, session: OpsBridgeSession): void {
  if (!isOpsToken(token)) throw new Error('An ops token is 32 hex characters.')
  sessions.set(token, session)
}

export function revokeToken(token: string): void {
  sessions.delete(token)
  // A relay still connected under a revoked token gets nothing more.
  for (const sock of sockets) {
    if ((sock as SocketWithToken).opsToken === token) sock.destroy()
  }
}

/** A fresh token: 16 random bytes as hex. */
export function newOpsToken(): string {
  return randomBytes(16).toString('hex')
}

type SocketWithToken = net.Socket & { opsToken?: string }

function serveConnection(socket: SocketWithToken): void {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
  socket.on('error', () => socket.destroy())
  const splitter = createLineSplitter()
  // One call at a time per connection: the CLI awaits each anyway, and the per-host queue
  // and the ledger read best in the order the model asked.
  let chain: Promise<void> = Promise.resolve()

  socket.on('data', (chunk: Buffer) => {
    const { lines, error } = splitter.push(chunk)
    const parsed: OpsBridgeRequest[] = []
    for (const line of lines) {
      const r = parseRequest(line)
      if (!r.ok) {
        socket.destroy()
        return
      }
      parsed.push(r.msg)
    }
    if (error) {
      socket.destroy()
      return
    }
    for (const msg of parsed) {
      const session = sessions.get(msg.token)
      // Unknown token, or a second token on a bound connection: close without a word.
      if (!session || (socket.opsToken !== undefined && socket.opsToken !== msg.token)) {
        socket.destroy()
        return
      }
      socket.opsToken = msg.token
      chain = chain.then(() => answer(socket, session, msg))
    }
  })
}

async function answer(socket: net.Socket, session: OpsBridgeSession, msg: OpsBridgeRequest): Promise<void> {
  if (socket.destroyed) return
  // Revoked while queued behind an earlier call.
  if (!sessions.has(msg.token)) {
    socket.destroy()
    return
  }
  let reply: OpsBridgeReply
  try {
    if (msg.kind === 'hello') {
      reply = { id: msg.id, ok: true, result: { text: JSON.stringify(session.hello()), isError: false } }
    } else {
      const r = await session.call(msg.tool ?? '', msg.args)
      reply = { id: msg.id, ok: true, result: { text: r.text, isError: r.isError } }
    }
  } catch (e) {
    reply = { id: msg.id, ok: false, error: message(e) }
  }
  if (!socket.destroyed) socket.write(encodeReply(reply))
}
