import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { t } from './i18n'
import { keyTypeOf, knownHostsFile, parseTrustEntry, type TrustEntry } from './ssh-trust-pure'

const pending = new Map<string, Promise<boolean>>()

export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

const storePath = (): string => path.join(app.getPath('userData'), 'ssh-trust.json')
const endpointOf = (host: string, port: number): string => `${host.toLowerCase()}:${port}`

/** The raw store; a missing file is empty, anything else unreadable is an error. */
function readStore(): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    return parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(t('main.sshTrust.storeUnreadable'))
  }
}

function writeAtomic(filename: string, data: string, mode?: number): void {
  const tmp = `${filename}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, data, { flag: 'wx', ...(mode !== undefined ? { mode } : {}) })
  fs.renameSync(tmp, filename)
}

/** The entry to store for a key just seen: its type and full blob come along when the
 *  blob parses, so a known_hosts line can be written from it later. */
function entryFor(key: Buffer, fingerprint: string): TrustEntry {
  const type = keyTypeOf(key)
  return type ? { fp: fingerprint, type, key: key.toString('base64') } : { fp: fingerprint }
}

/** Trust belongs to a network endpoint, independently of account and saved-host ids. */
export async function verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean> {
  const endpoint = endpointOf(host, port)
  const fingerprint = hostFingerprint(key)
  const known = parseTrustEntry(readStore()[endpoint])
  if (known) {
    if (known.fp === fingerprint) {
      // A legacy fingerprint-only entry (or one missing its key) is upgraded now that the
      // full key is in hand. Failing to write that is not a reason to refuse the server.
      const fresh = entryFor(key, fingerprint)
      if (fresh.key && (known.type !== fresh.type || known.key !== fresh.key)) {
        try {
          const latest = readStore()
          if (parseTrustEntry(latest[endpoint])?.fp === fingerprint) {
            latest[endpoint] = fresh
            writeAtomic(storePath(), JSON.stringify(latest, null, 2))
          }
        } catch (error) {
          console.error(`[ssh-trust] could not record the key for ${endpoint}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return true
    }
    await dialog.showMessageBox({ type: 'error', title: t('main.sshTrust.changed.title'), message: t('main.sshTrust.changed.message', { endpoint }), detail: t('main.sshTrust.changed.detail', { known: known.fp, fingerprint }), buttons: [t('common.close')] })
    return false
  }
  const pendingKey = `${endpoint}/${fingerprint}`
  if (pending.has(pendingKey)) return pending.get(pendingKey)!
  const decision = (async () => {
    const result = await dialog.showMessageBox({ type: 'question', title: t('main.sshTrust.verify.title'), message: t('main.sshTrust.verify.message', { endpoint }), detail: t('main.sshTrust.verify.detail', { fingerprint }), buttons: [t('common.cancel'), t('main.sshTrust.verify.trust')], defaultId: 0, cancelId: 0, noLink: true })
    if (result.response !== 1) return false
    const latest = readStore()
    const current = parseTrustEntry(latest[endpoint])
    if (current && current.fp !== fingerprint) return false
    latest[endpoint] = entryFor(key, fingerprint)
    writeAtomic(storePath(), JSON.stringify(latest, null, 2))
    return true
  })()
  pending.set(pendingKey, decision)
  try { return await decision } finally { pending.delete(pendingKey) }
}

/** Whether this endpoint's full key (not only its fingerprint) is in the store. */
export function isEndpointKeyStored(host: string, port: number): boolean {
  try {
    const entry = parseTrustEntry(readStore()[endpointOf(host, port)])
    return !!(entry?.type && entry.key)
  } catch {
    return false
  }
}

/**
 * Writes `userData/ssh-known-hosts` from the store, for the `ssh` CLI to take as its
 * `UserKnownHostsFile`, and returns its path; null when the store or the file cannot be
 * read or written.
 */
export async function trustedKnownHostsPath(): Promise<string | null> {
  try {
    const store: Record<string, TrustEntry> = {}
    for (const [endpoint, raw] of Object.entries(readStore())) {
      const entry = parseTrustEntry(raw)
      if (entry) store[endpoint] = entry
    }
    const filename = path.join(app.getPath('userData'), 'ssh-known-hosts')
    writeAtomic(filename, knownHostsFile(store), 0o600)
    try { fs.chmodSync(filename, 0o600) } catch { /* best effort; Windows ignores most of it */ }
    return filename
  } catch (error) {
    console.error(`[ssh-trust] could not write the known_hosts file: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
