import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import { handleStreamLine, makeLineBuffer, StreamState } from './claude-stream'

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

function readHosts(): SshHost[] {
  try {
    if (!fs.existsSync(hostsPath)) return []
    const buf = fs.readFileSync(hostsPath)
    const json = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
    return JSON.parse(json)
  } catch {
    return []
  }
}

function writeHosts(hosts: SshHost[]): void {
  const json = JSON.stringify(hosts)
  const data = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, 'utf-8')
  fs.writeFileSync(hostsPath, data)
}

function toPublic(h: SshHost): SshHostPublic {
  const { password, passphrase, ...rest } = h
  return { ...rest, hasSecret: !!(password || passphrase) }
}

export function listHosts(): SshHostPublic[] {
  return readHosts().map(toPublic)
}

let seq = 0
function genId(): string {
  seq += 1
  return `ssh_${seq}_${(seq * 7919) % 100000}`
}

export function saveHost(input: SshHost): SshHostPublic[] {
  const hosts = readHosts()
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
  writeHosts(hosts)
  return listHosts()
}

export function deleteHost(id: string): SshHostPublic[] {
  writeHosts(readHosts().filter((h) => h.id !== id))
  return listHosts()
}

export function buildConnectConfig(h: SshHost): ConnectConfig {
  const conf: ConnectConfig = {
    host: h.host,
    port: h.port || 22,
    username: h.username,
    readyTimeout: 20000
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
  return readHosts().find((h) => h.id === id) ?? null
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

export function testConnection(id: string): Promise<{ ok: boolean; message: string }> {
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
        stream.on('close', () =>
          done({ ok: true, message: out.trim() || 'Connected. Claude Code reachable.' })
        )
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

const activeConns = new Map<string, Client>()

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface RemoteRunHandlers {
  onEvent: (e: Record<string, unknown>) => void
  onDone: (d: { claudeSessionId?: string; costUsd: number; isError: boolean; errorText?: string }) => void
  onError: (msg: string) => void
}

/**
 * Run the remote host's Claude Code in headless stream-json mode and translate its line
 * events into the same shapes the local Agent SDK path emits, so the chat UI is identical.
 */
export function runRemote(
  appSessionId: string,
  hostId: string,
  prompt: string,
  model: string | undefined,
  claudeSessionId: string | undefined,
  cwd: string | undefined,
  h: RemoteRunHandlers
): void {
  const host = getHost(hostId)
  if (!host) {
    h.onError('SSH host not found')
    return
  }

  const conn = new Client()
  activeConns.set(appSessionId, conn)
  const state: StreamState = { sessionId: claudeSessionId }

  conn.on('ready', () => {
    const claude = host.claudePath || 'claude'
    const flags = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-mode', 'acceptEdits']
    if (model) flags.push('--model', model)
    if (claudeSessionId) flags.push('--resume', claudeSessionId)
    // Per-chat folder (from the config bar) overrides the host's default remote path.
    const dir = cwd || host.remotePath
    const cd = dir ? `cd ${shQuote(dir)} && ` : ''
    const cmd = `${cd}${claude} ${flags.join(' ')}`

    conn.exec(cmd, (err, stream) => {
      if (err) {
        h.onError(err.message)
        conn.end()
        activeConns.delete(appSessionId)
        return
      }

      let stderr = ''
      const lines = makeLineBuffer((line) => handleStreamLine(line, appSessionId, state, h))

      stream.on('data', (d: Buffer) => lines.push(d.toString()))
      stream.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
      stream.on('close', (code: number) => {
        lines.flush()
        if (code && code !== 0 && stderr.trim()) h.onError(stderr.trim().slice(0, 500))
        conn.end()
        activeConns.delete(appSessionId)
      })

      // Send the prompt over stdin and close it so `claude -p` runs once and exits.
      stream.end(prompt)
    })
  })

  conn.on('error', (e) => {
    h.onError(e.message)
    activeConns.delete(appSessionId)
  })

  try {
    conn.connect(buildConnectConfig(host))
  } catch (e) {
    h.onError(e instanceof Error ? e.message : String(e))
    activeConns.delete(appSessionId)
  }
}

export function stopRemote(appSessionId: string): boolean {
  const conn = activeConns.get(appSessionId)
  if (conn) {
    conn.end()
    activeConns.delete(appSessionId)
    return true
  }
  return false
}
