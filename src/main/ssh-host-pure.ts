import type { TFunction } from '../shared/i18n'

/**
 * Cleaning the text fields of a stored SSH host before they are saved. A pasted address
 * often carries a trailing space or a zero-width character, which Node then resolves as a
 * name ("getaddrinfo ENOTFOUND 192.168.1.10") instead of connecting. Secrets are left
 * alone: a password or passphrase may start or end with a space on purpose.
 */

/** Zero-width space/joiners and the word joiner: invisible, and `trim()` keeps them. */
const INVISIBLE = /[​-‍⁠]/g

/** Strip invisible characters, then surrounding whitespace (including a BOM and NBSP). */
export function cleanHostText(value: string): string {
  return value.replace(INVISIBLE, '').trim()
}

interface HostText {
  name: string
  host: string
  username: string
  privateKeyPath?: string
  remotePath?: string
  claudePath?: string
}

/** `input` with its address, name and path fields cleaned; everything else is untouched. */
export function cleanHostFields<T extends HostText>(input: T): T {
  const out = {
    ...input,
    name: cleanHostText(input.name),
    host: cleanHostText(input.host),
    username: cleanHostText(input.username)
  }
  if (input.privateKeyPath !== undefined) out.privateKeyPath = cleanHostText(input.privateKeyPath)
  if (input.remotePath !== undefined) out.remotePath = cleanHostText(input.remotePath)
  if (input.claudePath !== undefined) out.claudePath = cleanHostText(input.claudePath)
  return out
}

export interface HostSecrets {
  password?: string
  passphrase?: string
}

/**
 * The secrets a saved host ends up with. For each field: `undefined` (or an empty string)
 * keeps the stored value, `null` clears it, a non-empty string replaces it. A secret the
 * chosen auth type does not use is dropped, so switching auth type leaves nothing stale.
 */
export function mergeSecrets(
  prev: HostSecrets | undefined,
  input: { authType: 'password' | 'key' | 'agent'; password?: string | null; passphrase?: string | null }
): HostSecrets {
  const pick = (next: string | null | undefined, old: string | undefined): string | undefined =>
    next === null ? undefined : next ? next : old
  const out: HostSecrets = {}
  if (input.authType === 'password') {
    const v = pick(input.password, prev?.password)
    if (v) out.password = v
  } else if (input.authType === 'key') {
    const v = pick(input.passphrase, prev?.passphrase)
    if (v) out.passphrase = v
  }
  return out
}

interface ConnectionFields {
  host: string
  port?: number
  username: string
  authType: 'password' | 'key' | 'agent'
  privateKeyPath?: string
}

/**
 * Did an edit change what a pooled connection to the host was opened with? True when the
 * address, port, user, auth type or key path differ, or a secret was cleared (`null`) or
 * replaced (non-empty string). Text is compared after cleaning, as it is saved.
 */
export function connectionFieldsChanged(
  prev: ConnectionFields,
  next: ConnectionFields & { password?: string | null; passphrase?: string | null }
): boolean {
  const a = cleanHostFields({ name: '', ...prev })
  const b = cleanHostFields({ name: '', ...next })
  if (a.host !== b.host || a.username !== b.username) return true
  if ((prev.port || 22) !== (next.port || 22)) return true
  if (prev.authType !== next.authType) return true
  if ((a.privateKeyPath ?? '') !== (b.privateKeyPath ?? '')) return true
  const secretTouched = (v: string | null | undefined): boolean => v === null || (typeof v === 'string' && v !== '')
  return secretTouched(next.password) || secretTouched(next.passphrase)
}

/**
 * Reading the saved hosts file. A failed read must never look like "no hosts": the write
 * paths do read-modify-write, so mistaking a transient decrypt failure for an empty list
 * and then saving would silently destroy every host and its secrets.
 */
export type HostsRead<T> = { ok: true; hosts: T[] } | { ok: false; error: string }

export interface HostsCodec {
  /** `safeStorage.isEncryptionAvailable()` right now. */
  encryptionAvailable: boolean
  /** `safeStorage.decryptString`; may throw. */
  decrypt: (buf: Buffer) => string
}

function parseHostList<T>(json: string): T[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error('not a list of hosts')
  return parsed as T[]
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Decode the file's bytes into a host list. The file may have been written in the other
 * mode (encrypted vs plaintext) on an earlier run, as encryption availability can change
 * between launches, so the current mode is tried first and the other one as a fallback.
 * Only when both fail is it an error.
 */
export function decodeHostsFile<T>(buf: Buffer, codec: HostsCodec): HostsRead<T> {
  const encrypted = (): T[] => parseHostList<T>(codec.decrypt(buf))
  const plain = (): T[] => parseHostList<T>(buf.toString('utf-8'))
  const attempts: [string, () => T[]][] = codec.encryptionAvailable
    ? [['encrypted', encrypted], ['plaintext', plain]]
    : [['plaintext', plain], ['encrypted', encrypted]]
  const failures: string[] = []
  for (const [mode, attempt] of attempts) {
    try {
      return { ok: true, hosts: attempt() }
    } catch (e) {
      failures.push(`${mode}: ${reason(e)}`)
    }
  }
  return { ok: false, error: failures.join('; ') }
}

/** The error a write path reports instead of overwriting a file it could not read. */
export function refuseOverwriteMessage(t: TFunction, file: string, readError: string): string {
  return t('main.ssh.hostsUnreadable', { error: readError, file })
}
