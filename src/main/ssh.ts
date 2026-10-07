import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import { randomUUID } from 'crypto'
import { verifyHostKey } from './ssh-trust'
import { cleanHostFields, decodeHostsFile, refuseOverwriteMessage, type HostsRead } from './ssh-host-pure'

export type SshAuthType = 'password' | 'key' | 'agent'

export interface SshHost {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: SshAuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  remotePath?: string
  claudePath?: string
}

/** Host with secrets stripped — safe to hand to the renderer. */
export type SshHostPublic = Omit<SshHost, 'password' | 'passphrase'> & { hasSecret: boolean }

const hostsPath = path.join(app.getPath('userData'), 'ssh-hosts.bin')

/**
 * A missing file is an empty list; any other failure (unreadable, corrupt, undecryptable in
 * both modes) is an error, so the write paths can refuse to overwrite it.
 */
function readHosts(): HostsRead<SshHost> {
  let buf: Buffer
  try {
    buf = fs.readFileSync(hostsPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { ok: true, hosts: [] }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return decodeHostsFile<SshHost>(buf, {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    decrypt: (b) => safeStorage.decryptString(b)
  })
}

/** Read-only callers: an unreadable file shows as no hosts (logged), nothing is written. */
function readHostsOrEmpty(): SshHost[] {
  const res = readHosts()
  if (res.ok) return res.hosts
  console.error(`[ssh] could not read ${hostsPath}: ${res.error}`)
  return []
}

export type HostsWriteResult = { ok: true; hosts: SshHostPublic[] } | { ok: false; error: string }

/**
 * Read-modify-write, fail-closed: when the file cannot be read, nothing is written, since
 * writing would replace every saved host (and its secrets) with whatever `mutate` built
 * from an empty list.
 */
function updateHosts(mutate: (hosts: SshHost[]) => SshHost[]): HostsWriteResult {
  const res = readHosts()
  if (!res.ok) return { ok: false, error: refuseOverwriteMessage(hostsPath, res.error) }
  try {
    writeHosts(mutate(res.hosts))
  } catch (e) {
    return { ok: false, error: `Could not save the hosts file: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, hosts: listHosts() }
}

function writeHosts(hosts: SshHost[]): void {
  const json = JSON.stringify(hosts)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8')
  // Write-then-rename: an interrupted write must never leave the file truncated, since an
  // unreadable file blocks every later save until the user moves it aside.
  const tmp = `${hostsPath}.tmp`
  fs.writeFileSync(tmp, data)
  fs.renameSync(tmp, hostsPath)
}

function toPublic(h: SshHost): SshHostPublic {
  const { password, passphrase, ...rest } = h
  return { ...rest, hasSecret: !!(password || passphrase) }
}

export function listHosts(): SshHostPublic[] {
  return readHostsOrEmpty().map(toPublic)
}

function genId(): string {
  return `ssh_${randomUUID()}`
}

export function saveHost(raw: SshHost): HostsWriteResult {
  const input = cleanHostFields(raw)
  return updateHosts((hosts) => {
    const idx = input.id ? hosts.findIndex((h) => h.id === input.id) : -1
    if (idx >= 0) {
      const prev = hosts[idx]
      // Preserve existing secrets if the renderer didn't supply new ones (it never receives them).
      hosts[idx] = {
        ...input,
        password: input.password || prev.password,
        passphrase: input.passphrase || prev.passphrase
      }
    } else {
      hosts.push({ ...input, id: input.id || genId() })
    }
    return hosts
  })
}

export function deleteHost(id: string): HostsWriteResult {
  return updateHosts((hosts) => hosts.filter((h) => h.id !== id))
}

export function buildConnectConfig(h: SshHost): ConnectConfig {
  const conf: ConnectConfig = {
    host: h.host,
    port: h.port || 22,
    username: h.username,
    readyTimeout: 120000,
    hostVerifier: (key: Buffer, callback: (valid: boolean) => void) => {
      verifyHostKey(h.host, h.port || 22, key).then(callback, () => callback(false))
    }
  }
  if (h.authType === 'password') {
    conf.password = h.password
  } else if (h.authType === 'key' && h.privateKeyPath) {
    conf.privateKey = fs.readFileSync(h.privateKeyPath)
    if (h.passphrase) conf.passphrase = h.passphrase
  } else if (h.authType === 'agent') {
    conf.agent =
      process.env.SSH_AUTH_SOCK ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
  }
  return conf
}

export function getHost(id: string): SshHost | null {
  return readHostsOrEmpty().find((h) => h.id === id) ?? null
}

/**
 * Build an interactive `ssh` CLI invocation for a stored host, for the embedded terminal
 * to spawn directly (distinct from the headless ssh2 connection `runRemote` uses for
 * one-shot `claude -p` calls). Password auth has no non-interactive flag here — the user
 * is prompted by `ssh` itself inside the terminal.
 */
export function getSshTerminalCommand(
  hostId: string
): { shell: string; args: string[]; remotePath?: string; claudePath?: string } | null {
  const h = getHost(hostId)
  if (!h) return null
  const args: string[] = ['-t']
  if (h.port && h.port !== 22) args.push('-p', String(h.port))
  if (h.authType === 'key' && h.privateKeyPath) {
    args.push('-i', h.privateKeyPath, '-o', 'IdentitiesOnly=yes')
  }
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push(`${h.username}@${h.host}`)
  return { shell: 'ssh', args, remotePath: h.remotePath, claudePath: h.claudePath }
}

/**
 * Does this host accept an SSH connection? Nothing more — it authenticates, reports how
 * long that took, and hangs up. This is what the Remote & WSL list's status dot reflects,
 * so it deliberately does NOT care whether Claude Code is installed: a box can be perfectly
 * reachable without it, and conflating the two meant a green/red dot that answered the wrong
 * question. Use testClaude for that.
 */
export function testConnection(id: string): Promise<{ ok: boolean; message: string }> {
  const host = getHost(id)
  if (!host) return Promise.resolve({ ok: false, message: 'Host not found' })

  return new Promise((resolve) => {
    const conn = new Client()
    const startedAt = Date.now()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      conn.end()
      resolve(r)
    }
    conn.on('ready', () =>
      done({
        ok: true,
        message: `Connected as ${host.username}@${host.host}:${host.port} in ${Date.now() - startedAt} ms`
      })
    )
    conn.on('error', (e) => done({ ok: false, message: e.message }))
    try {
      conn.connect(buildConnectConfig(host))
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  })
}

/**
 * Connects and asks the host's `claude` for its version — the "is Claude Code actually
 * installed and runnable over there" check, which is a separate question from whether the
 * host is up (see testConnection).
 */
export function testClaude(id: string): Promise<{ ok: boolean; message: string }> {
  const host = getHost(id)
  if (!host) return Promise.resolve({ ok: false, message: 'Host not found' })

  return new Promise((resolve) => {
    const conn = new Client()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      conn.end()
      resolve(r)
    }
    conn.on('ready', () => {
      const claude = host.claudePath || 'claude'
      conn.exec(`${claude} --version`, (err, stream) => {
        if (err) return done({ ok: false, message: `Connected, but: ${err.message}` })
        let out = ''
        stream.on('data', (d: Buffer) => (out += d.toString()))
        stream.stderr.on('data', (d: Buffer) => (out += d.toString()))
        stream.on('close', () => {
          const text = out.trim()
          const firstLine = text.split('\n')[0] ?? ''
          // Previously this resolved ok:true whenever the stream closed, so a missing
          // `claude` reported success with "command not found" as its message.
          const looksLikeVersion = /\d+\.\d+\.\d+/.test(firstLine)
          if (looksLikeVersion) return done({ ok: true, message: firstLine })
          if (/not found|no such file/i.test(text)) {
            return done({
              ok: false,
              message: `claude not found on this host (${host.claudePath || 'claude'}). Install it: npm i -g @anthropic-ai/claude-code`
            })
          }
          done({ ok: false, message: text.slice(0, 300) || 'claude produced no output' })
        })
      })
    })
    conn.on('error', (e) => done({ ok: false, message: e.message }))
    try {
      conn.connect(buildConnectConfig(host))
    } catch (e) {
      done({ ok: false, message: e instanceof Error ? e.message : String(e) })
    }
  })
}
