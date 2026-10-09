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
