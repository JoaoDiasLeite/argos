import { cleanHostText, isSafeSshHost } from './ssh-host-pure'

/**
 * Local port forwards ("tunnels") kept with a saved SSH host: a listener on this computer's
 * loopback whose connections are carried over the host's SSH connection to `remoteHost:
 * remotePort` as the server sees it. Not secret: the field is on the public allowlist.
 */
export interface PortForward {
  id: string
  label: string
  /** 0 picks a free port each time the tunnel starts. */
  localPort: number
  /** Resolved by the server, so `localhost` is the server itself. */
  remoteHost: string
  remotePort: number
  /** Starts when the host's Remote Session opens. */
  autoStart?: boolean
}

export const MAX_FORWARDS = 20
export const MAX_FORWARD_LABEL = 64
export const DEFAULT_REMOTE_HOST = 'localhost'

/**
 * Where every tunnel listens. Loopback only, never 0.0.0.0: a tunnel to a client's database
 * must not become a door into it for anyone on the same network as this computer.
 */
export const LISTEN_HOST = '127.0.0.1'

/** The options a tunnel's server listens with. `exclusive` keeps a port another process
 *  already holds from being shared on platforms that would otherwise allow it. */
export function listenOptions(localPort: number): { host: typeof LISTEN_HOST; port: number; exclusive: true } {
  return { host: LISTEN_HOST, port: localPort, exclusive: true }
}

/** Ids come from the renderer (crypto.randomUUID) and only ever key a map. */
const FORWARD_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isPort(v: unknown, allowZero = false): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v <= 65535 && (v >= 1 || (allowZero && v === 0))
}

export type ForwardProblem = 'tooMany' | 'id' | 'localPort' | 'duplicateLocalPort' | 'remoteHost' | 'remotePort'

export type ForwardsCheck =
  | { ok: true; forwards: PortForward[] }
  | { ok: false; problem: ForwardProblem; /** 0-based, absent for `tooMany`. */ index?: number }

/** One forward as it is saved, or the first thing wrong with it. */
function cleanForward(raw: unknown): PortForward | Exclude<ForwardProblem, 'tooMany' | 'duplicateLocalPort'> {
  if (!raw || typeof raw !== 'object') return 'id'
  const f = raw as Record<string, unknown>
  if (typeof f.id !== 'string' || !FORWARD_ID.test(f.id)) return 'id'
  if (!isPort(f.localPort, true)) return 'localPort'
  const remoteHost = typeof f.remoteHost === 'string' ? cleanHostText(f.remoteHost) || DEFAULT_REMOTE_HOST : DEFAULT_REMOTE_HOST
  if (!isSafeSshHost(remoteHost)) return 'remoteHost'
  if (!isPort(f.remotePort)) return 'remotePort'
  const label = typeof f.label === 'string' ? cleanHostText(f.label).slice(0, MAX_FORWARD_LABEL).trim() : ''
  const out: PortForward = { id: f.id, label, localPort: f.localPort, remoteHost, remotePort: f.remotePort }
  if (f.autoStart === true) out.autoStart = true
  return out
}

/**
 * The forwards a host is saved with, or why they cannot be. Absent or not a list is no
 * forwards. A fixed local port may appear once per host, since the second listener could
 * never start; ids must be unique, as they key the running tunnels.
 */
export function checkForwards(value: unknown): ForwardsCheck {
  if (value === undefined || value === null) return { ok: true, forwards: [] }
  if (!Array.isArray(value)) return { ok: false, problem: 'id', index: 0 }
  if (value.length > MAX_FORWARDS) return { ok: false, problem: 'tooMany' }
  const forwards: PortForward[] = []
  const ids = new Set<string>()
  const ports = new Set<number>()
  for (let i = 0; i < value.length; i++) {
    const f = cleanForward(value[i])
    if (typeof f === 'string') return { ok: false, problem: f, index: i }
    if (ids.has(f.id)) return { ok: false, problem: 'id', index: i }
    if (f.localPort !== 0 && ports.has(f.localPort)) return { ok: false, problem: 'duplicateLocalPort', index: i }
    ids.add(f.id)
    if (f.localPort !== 0) ports.add(f.localPort)
    forwards.push(f)
  }
  return { ok: true, forwards }
}

/**
 * The usable forwards of a stored host, dropping any that would not pass checkForwards: a
 * host from a profile import or a hand-edited file never went through the save path, and
 * nothing it holds may reach a listener or the renderer unchecked.
 */
export function usableForwards(value: unknown): PortForward[] {
  if (!Array.isArray(value)) return []
  const out: PortForward[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    const f = cleanForward(raw)
    if (typeof f === 'string' || ids.has(f.id)) continue
    ids.add(f.id)
    out.push(f)
    if (out.length >= MAX_FORWARDS) break
  }
  return out
}

/** The i18n key that explains a ForwardProblem. */
export function forwardProblemKey(p: ForwardProblem): `main.forwards.invalid.${ForwardProblem}` {
  return `main.forwards.invalid.${p}`
}

/** Did the part of a forward a running listener was opened with change? */
export function forwardTargetChanged(a: PortForward, b: PortForward): boolean {
  return a.localPort !== b.localPort || a.remoteHost !== b.remoteHost || a.remotePort !== b.remotePort
}

/** The listen error codes with their own message; anything else is shown as Node says it. */
export function listenErrorKind(code: unknown): 'inUse' | 'denied' | 'other' {
  if (code === 'EADDRINUSE') return 'inUse'
  // Windows reserves port ranges (Hyper-V, WSL) and reports a bind inside one as EACCES.
  if (code === 'EACCES') return 'denied'
  return 'other'
}

/** What the renderer is told about one tunnel. `active` false is a tunnel that stopped on
 *  its own (its connection closed); `error` then says why. */
export interface ForwardStatus {
  hostId: string
  forwardId: string
  localPort: number
  connections: number
  startedAt: number
  active: boolean
  /** Why it stopped, or, while active, the last connection the server refused. */
  error?: string
}

interface TableEntry<C> extends ForwardStatus {
  /** The SSH connection the listener rides; a close of exactly that one stops it. */
  conn: C
  /** The forward as it was started, to tell whether an edit changed it. */
  forward: PortForward
}

const keyOf = (hostId: string, forwardId: string): string => `${hostId}\u0000${forwardId}`

/**
 * The tunnels main knows about: the ones running and the ones that stopped on their own,
 * kept with their reason until the user starts or dismisses them. `C` is the connection
 * identity (the ssh2 Client), compared by reference only.
 */
export class ForwardTable<C> {
  private entries = new Map<string, TableEntry<C>>()
  private starting = new Set<string>()

  /** Claims a start; false while that forward is starting or running, so a double click or
   *  a start still waiting on the password prompt cannot open a second listener. */
  begin(hostId: string, forwardId: string): boolean {
    const k = keyOf(hostId, forwardId)
    if (this.starting.has(k) || this.entries.get(k)?.active) return false
    this.starting.add(k)
    return true
  }

  /** Releases a claim from begin() that did not end in a running listener. */
  abandon(hostId: string, forwardId: string): void {
    this.starting.delete(keyOf(hostId, forwardId))
  }

  isStarting(hostId: string, forwardId: string): boolean {
    return this.starting.has(keyOf(hostId, forwardId))
  }

  running(hostId: string, forward: PortForward, localPort: number, conn: C, startedAt = Date.now()): void {
    const k = keyOf(hostId, forward.id)
    this.starting.delete(k)
    this.entries.set(k, { hostId, forwardId: forward.id, localPort, connections: 0, startedAt, active: true, conn, forward })
  }

  get(hostId: string, forwardId: string): ForwardStatus | undefined {
    const e = this.entries.get(keyOf(hostId, forwardId))
    return e ? publicStatus(e) : undefined
  }

  /** The forward a running listener was started with. */
  startedWith(hostId: string, forwardId: string): PortForward | undefined {
    const e = this.entries.get(keyOf(hostId, forwardId))
    return e?.active ? e.forward : undefined
  }

  setConnections(hostId: string, forwardId: string, n: number): boolean {
    const e = this.entries.get(keyOf(hostId, forwardId))
    if (!e?.active || e.connections === n) return false
    e.connections = n
    return true
  }

  /** The last refused connection of a running tunnel, or undefined to clear it. */
  setError(hostId: string, forwardId: string, error: string | undefined): boolean {
    const e = this.entries.get(keyOf(hostId, forwardId))
    if (!e?.active || e.error === error) return false
    if (error === undefined) delete e.error
    else e.error = error
    return true
  }

  /**
   * Ends a tunnel. With a reason it stays listed as stopped with that reason (it ended on
   * its own and the user should see why); without one it is dropped (the user stopped it).
   * Returns whether anything changed.
   */
  stop(hostId: string, forwardId: string, reason?: string): boolean {
    const k = keyOf(hostId, forwardId)
    const e = this.entries.get(k)
    if (!e) return false
    if (reason === undefined) {
      this.entries.delete(k)
      return true
    }
    if (!e.active) return false
    e.active = false
    e.connections = 0
    e.error = reason
    return true
  }

  /** The running tunnels riding `conn`, for when that connection closes. */
  runningOn(conn: C): { hostId: string; forwardId: string }[] {
    return [...this.entries.values()].filter((e) => e.active && e.conn === conn).map(({ hostId, forwardId }) => ({ hostId, forwardId }))
  }

  /** Whether any running tunnel still rides `conn`. */
  usesConn(conn: C): boolean {
    for (const e of this.entries.values()) if (e.active && e.conn === conn) return true
    return false
  }

  /** Every listed tunnel of a host, running or stopped. */
  ofHost(hostId: string): ForwardStatus[] {
    return [...this.entries.values()].filter((e) => e.hostId === hostId).map(publicStatus)
  }

  list(): ForwardStatus[] {
    return [...this.entries.values()].map(publicStatus)
  }
}

function publicStatus<C>(e: TableEntry<C>): ForwardStatus {
  const out: ForwardStatus = {
    hostId: e.hostId,
    forwardId: e.forwardId,
    localPort: e.localPort,
    connections: e.connections,
    startedAt: e.startedAt,
    active: e.active
  }
  if (e.error !== undefined) out.error = e.error
  return out
}
