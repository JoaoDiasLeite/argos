import { app, dialog } from 'electron'
import { createHash, randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

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
      throw new Error('SSH trust store could not be read. Connection refused.')
    }
  }
  const known = read()[endpoint]
  if (known) {
    if (known === fingerprint) return true
    await dialog.showMessageBox({ type: 'error', title: 'SSH host key changed', message: `Connection to ${endpoint} was refused.`, detail: `Trusted: ${known}\nReceived: ${fingerprint}\nVerify the server identity with its administrator before changing trust.`, buttons: ['Close'] })
    return false
  }
  const pendingKey = `${endpoint}/${fingerprint}`
  if (pending.has(pendingKey)) return pending.get(pendingKey)!
  const decision = (async () => {
    const result = await dialog.showMessageBox({ type: 'question', title: 'Verify SSH server', message: `Trust ${endpoint}?`, detail: `Server fingerprint:\n${fingerprint}\nCompare this with the fingerprint supplied by the server administrator.`, buttons: ['Cancel', 'Trust this server'], defaultId: 0, cancelId: 0, noLink: true })
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
