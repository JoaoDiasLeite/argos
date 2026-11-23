import { safeStorage } from 'electron'
import * as fs from 'fs'
import { t } from './i18n'
import { decodeHostsFile, type HostsRead } from './ssh-host-pure'

/**
 * A JSON list kept in one safeStorage-encrypted file under userData, holding secrets: the
 * saved SSH hosts (`ssh-hosts.bin`) and the shared credentials (`ssh-credentials.bin`).
 * Both need the same discipline, so it lives here once:
 *  - a missing file is an empty list, any other failed read is an error (fail-closed);
 *  - a write path never replaces a file it could not read, since that would destroy every
 *    entry (and its secrets) on a transient decrypt failure;
 *  - writes go to a temporary file and are renamed into place;
 *  - plaintext only when safeStorage has no encryption (the forms warn about it).
 */
export interface EncryptedListStore<T> {
  readonly file: string
  read(): HostsRead<T>
  /** Read-only callers: an unreadable file shows as an empty list (logged), nothing is written. */
  readOrEmpty(): T[]
  /** Read-modify-write, fail-closed. The error is ready to show to the user. */
  update(mutate: (items: T[]) => T[]): { ok: true } | { ok: false; error: string }
}

/** The messages a write path reports, naming the file in the user's words. */
export interface StoreMessages {
  /** Takes `{ error, file }`. */
  unreadable: 'main.ssh.hostsUnreadable' | 'main.ssh.credentialsUnreadable'
  /** Takes `{ error }`. */
  saveFailed: 'main.ssh.hostsSaveFailed' | 'main.ssh.credentialsSaveFailed'
}

export function createEncryptedListStore<T>(file: string, logTag: string, messages: StoreMessages): EncryptedListStore<T> {
  const read = (): HostsRead<T> => {
    let buf: Buffer
    try {
      buf = fs.readFileSync(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, hosts: [] }
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return decodeHostsFile<T>(buf, {
      encryptionAvailable: safeStorage.isEncryptionAvailable(),
      decrypt: (b) => safeStorage.decryptString(b)
    })
  }

  const write = (items: T[]): void => {
    const json = JSON.stringify(items)
    const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json, 'utf-8')
    // Write-then-rename: an interrupted write must never leave the file truncated, since an
    // unreadable file blocks every later save until the user moves it aside.
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
  }

  return {
    file,
    read,
    readOrEmpty() {
      const res = read()
      if (res.ok) return res.hosts
      console.error(`[${logTag}] could not read ${file}: ${res.error}`)
      return []
    },
    update(mutate) {
      const res = read()
      if (!res.ok) return { ok: false, error: t(messages.unreadable, { error: res.error, file }) }
      try {
        write(mutate(res.hosts))
      } catch (e) {
        return { ok: false, error: t(messages.saveFailed, { error: e instanceof Error ? e.message : String(e) }) }
      }
      return { ok: true }
    }
  }
}
