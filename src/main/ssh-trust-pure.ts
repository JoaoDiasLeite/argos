/**
 * The pure half of the SSH host-key trust store (ssh-trust.ts): entry shapes and the
 * OpenSSH known_hosts text derived from them. No Electron, no fs.
 */
import { createHash } from 'crypto'

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

/**
 * Trust scoped by gateway. Each client is reached through its own VPN on a gateway, and two
 * clients' private addresses can be the same (10.0.0.5 at both), so a host reached through a
 * gateway is trusted under that gateway as well:
 *  - direct: `host:port`, the host lowercased (unchanged, so nothing already trusted breaks);
 *  - through a gateway: `<gatewayHostId>/host:port`. The gateway's saved-host id, not its
 *    address: editing the gateway's address keeps its clients' keys, and two gateways never
 *    share one. An id that is not plain `[A-Za-z0-9_-]` is refused (null).
 * The ssh CLI looks such a host up by `HostKeyAlias` (trustAlias), written into the generated
 * known_hosts in place of `[host]:port`.
 */
export function trustKey(host: string, port: number, gatewayId?: string): string | null {
  const ep = `${host.toLowerCase()}:${port}`
  if (gatewayId === undefined) return ep
  return /^[A-Za-z0-9_-]{1,100}$/.test(gatewayId) ? `${gatewayId}/${ep}` : null
}

/** A store key split into its gateway scope (if any) and the `host:port` after it. */
export function splitTrustKey(key: string): { gatewayId?: string; endpoint: string } {
  const slash = key.indexOf('/')
  return slash > 0 ? { gatewayId: key.slice(0, slash), endpoint: key.slice(slash + 1) } : { endpoint: key }
}

/**
 * The `HostKeyAlias` the ssh CLI uses for a scoped key: `argos-jump-` and the first 32 hex
 * digits of the key's SHA-256. Only letters, digits and `-`, so it is safe as an argument and
 * as a known_hosts host field, and the same key always gives the same alias.
 */
export function trustAlias(scopedKey: string): string {
  return `argos-jump-${createHash('sha256').update(scopedKey).digest('hex').slice(0, 32)}`
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
  for (const [storeKey, entry] of Object.entries(store)) {
    if (!entry?.type || !entry.key) continue
    const { gatewayId, endpoint } = splitTrustKey(storeKey)
    const ep = splitEndpoint(endpoint)
    if (!ep || !SAFE_HOST.test(ep.host) || !SAFE_TYPE.test(entry.type) || !SAFE_B64.test(entry.key)) continue
    // A host behind a gateway is listed under its alias only: `[10.0.0.5]:22` would match
    // the same address at every client.
    if (gatewayId !== undefined) lines.push(`${trustAlias(storeKey)} ${entry.type} ${entry.key}`)
    else lines.push(knownHostsLine(ep.host, ep.port, entry.type, entry.key))
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
