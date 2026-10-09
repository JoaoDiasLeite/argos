import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { t } from './i18n'

const pending = new Map<string, Promise<boolean>>()

export function hostFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** Trust belongs to a network endpoint, independently of account and saved-host ids. */
export async function verifyHostKey(host: string, port: number, key: Buffer): Promise<boolean> {
  const endpoint = `${host.toLowerCase()}:${port}`
  const fingerprint = hostFingerprint(key)
  const filename = path.join(app.getPath('userData'), 'ssh-trust.json')
  const read = (): Record<string, string> => {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw new Error(t('main.sshTrust.storeUnreadable'))
    }
  }
  const known = read()[endpoint]
  if (known) {
    if (known === fingerprint) return true
    await dialog.showMessageBox({ type: 'error', title: t('main.sshTrust.changed.title'), message: t('main.sshTrust.changed.message', { endpoint }), detail: t('main.sshTrust.changed.detail', { known, fingerprint }), buttons: [t('common.close')] })
    return false
  }
  const pendingKey = `${endpoint}/${fingerprint}`
  if (pending.has(pendingKey)) return pending.get(pendingKey)!
  const decision = (async () => {
    const result = await dialog.showMessageBox({ type: 'question', title: t('main.sshTrust.verify.title'), message: t('main.sshTrust.verify.message', { endpoint }), detail: t('main.sshTrust.verify.detail', { fingerprint }), buttons: [t('common.cancel'), t('main.sshTrust.verify.trust')], defaultId: 0, cancelId: 0, noLink: true })
    if (result.response !== 1) return false
    const latest = read()
    if (latest[endpoint] && latest[endpoint] !== fingerprint) return false
    latest[endpoint] = fingerprint
    const tmp = `${filename}.${randomUUID()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(latest, null, 2), { flag: 'wx' })
    fs.renameSync(tmp, filename)
    return true
  })()
  pending.set(pendingKey, decision)
  try { return await decision } finally { pending.delete(pendingKey) }
}
