/**
 * The pure half of the SSH host-key trust store (ssh-trust.ts): entry shapes and the
 * OpenSSH known_hosts text derived from them. No Electron, no fs.
 */

/**
 * One trusted endpoint. `fp` is `SHA256:<base64, no padding>` of the wire key blob; `type`
 * (e.g. `ssh-ed25519`) and `key` (the whole blob, base64) are what a known_hosts line needs.
 * Older entries hold only the fingerprint, stored as a bare string.
 */
export type TrustEntry = { fp: string; type?: string; key?: string }

/** The key type of an SSH wire-format public key blob: its first length-prefixed string. */
export function keyTypeOf(blob: Buffer): string | null {
  if (blob.length < 4) return null
  const len = blob.readUInt32BE(0)
  if (len === 0 || len > 64 || 4 + len > blob.length) return null
  const type = blob.subarray(4, 4 + len).toString('latin1')
  return /^[\x21-\x7e]+$/.test(type) ? type : null
}

/** One OpenSSH known_hosts line; a non-default port takes the `[host]:port` form. */
export function knownHostsLine(host: string, port: number, type: string, keyB64: string): string {
  const name = port === 22 ? host : `[${host}]:${port}`
  return `${name} ${type} ${keyB64}`
}

/** A stored value in either shape: the legacy fingerprint string or the object form. */
export function parseTrustEntry(raw: unknown): TrustEntry | null {
  if (typeof raw === 'string') return raw ? { fp: raw } : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  if (typeof o.fp !== 'string' || !o.fp) return null
  const entry: TrustEntry = { fp: o.fp }
  if (typeof o.type === 'string' && o.type) entry.type = o.type
  if (typeof o.key === 'string' && o.key) entry.key = o.key
  return entry
}

/** Splits a `host:port` store key on its last ':' (an IPv6 host keeps its own colons). */
export function splitEndpoint(endpoint: string): { host: string; port: number } | null {
  const i = endpoint.lastIndexOf(':')
  if (i <= 0) return null
  const port = Number(endpoint.slice(i + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: endpoint.slice(0, i), port }
}

const SAFE_TYPE = /^[\x21-\x7e]+$/
const SAFE_B64 = /^[A-Za-z0-9+/]+=*$/
const SAFE_HOST = /^[^\s#,[\]]+$/

/** The known_hosts text for every entry that carries its full key; one line each. */
export function knownHostsFile(store: Record<string, TrustEntry>): string {
  const lines: string[] = []
  for (const [endpoint, entry] of Object.entries(store)) {
    if (!entry?.type || !entry.key) continue
    const ep = splitEndpoint(endpoint)
    if (!ep || !SAFE_HOST.test(ep.host) || !SAFE_TYPE.test(entry.type) || !SAFE_B64.test(entry.key)) continue
    lines.push(knownHostsLine(ep.host, ep.port, entry.type, entry.key))
  }
  return lines.length ? lines.join('\n') + '\n' : ''
}

/**
 * A file path as the value of an `ssh -o Option=value` argument. This is not shell quoting
 * (the argument already travels as one argv element): ssh itself splits the value of
 * `UserKnownHostsFile` on whitespace and expands `%` tokens in it, so a space-bearing path
 * is wrapped in ssh's own double quotes and a literal `%` is doubled.
 */
export function sshOptionPath(p: string): string {
  const escaped = p.replace(/%/g, '%%')
  return /\s/.test(escaped) ? `"${escaped}"` : escaped
}
