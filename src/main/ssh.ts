import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import { randomUUID } from 'crypto'
import { isEndpointKeyStored, trustedKnownHostsPath, verifyHostKey } from './ssh-trust'
import { sshOptionPath } from './ssh-trust-pure'
import { t } from './i18n'
import { keyboardInteractiveDecision, keyNeedsPassphrase, type KbdPrompt } from './connect-auth-pure'
import {
  cleanHostFields,
  decodeHostsFile,
  hostFieldProblem,
  hostFieldProblemKey,
  mergeSecrets,
  refuseOverwriteMessage,
  stripSecrets,
  toPublicHost,
  remoteCommandWord,
  sshDestinationArgs,
  type HostsRead,
  type SecretField,
  type SshHost,
  type SshHostPublic
} from './ssh-host-pure'

export type { SshAuthType, SshHost, SshHostPublic } from './ssh-host-pure'

/** What the renderer sends: `undefined` keeps a stored secret, `null` clears it. */
export type SshHostInput = Omit<SshHost, 'id' | SecretField> & {
  id?: string
} & { [K in SecretField]?: string | null }

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
  if (!res.ok) return { ok: false, error: refuseOverwriteMessage(t, hostsPath, res.error) }
  try {
    writeHosts(mutate(res.hosts))
  } catch (e) {
    return { ok: false, error: t('main.ssh.hostsSaveFailed', { error: e instanceof Error ? e.message : String(e) }) }
  }
  return { ok: true, hosts: listHosts() }
}

/** Whether saved secrets are really encrypted: on Linux without a keyring Electron reports
 * encryption as available but uses a hard-coded key ('basic_text'). */
export function secretStorageState(): { encrypted: boolean; backend?: string } {
  const available = safeStorage.isEncryptionAvailable()
  if (process.platform !== 'linux') return { encrypted: available }
  let backend: string | undefined
  try {
    backend = safeStorage.getSelectedStorageBackend()
  } catch {
    backend = undefined
  }
  return { encrypted: available && backend !== 'basic_text', backend }
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

export function listHosts(): SshHostPublic[] {
  return readHostsOrEmpty().map(toPublicHost)
}

function genId(): string {
  return `ssh_${randomUUID()}`
}

export function saveHost(raw: SshHostInput): HostsWriteResult {
  const fields = stripSecrets(cleanHostFields(raw))
  const problem = hostFieldProblem(fields)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  return updateHosts((hosts) => {
    const idx = fields.id ? hosts.findIndex((h) => h.id === fields.id) : -1
    const prev = idx >= 0 ? hosts[idx] : undefined
    const secrets = mergeSecrets(prev, raw)
    if (idx >= 0) {
      hosts[idx] = { ...fields, id: fields.id as string, ...secrets }
    } else {
      hosts.push({ ...fields, id: fields.id || genId(), ...secrets })
    }
    return hosts
  })
}

export function deleteHost(id: string): HostsWriteResult {
  return updateHosts((hosts) => hosts.filter((h) => h.id !== id))
}

/**
 * Saves a login password typed at the connect prompt with "save" ticked. Only the password
 * field changes, on a fresh read of the store (fail-closed like every write here), and only
 * while the host still exists and still logs in with a password: the form may have changed it
 * while the prompt was up. Not through saveHost, whose callers close the pooled connection
 * when a password is touched, and this one has just been opened with it.
 */
export function saveHostPassword(id: string, password: string): HostsWriteResult {
  return updateHosts((hosts) =>
    hosts.map((h) => (h.id === id && h.authType === 'password' ? { ...h, password } : h))
  )
}

export interface ConnectAuthOptions {
  /** True only for the user-opened Remote Session: someone is there to answer a prompt. */
  interactive: boolean
  /** Asks the user for one keyboard-interactive answer; null when they cancelled. */
  askSecret?: (prompt: string, echo: boolean) => Promise<string | null>
}

/**
 * keyboard-interactive is only tried when it can be answered: someone is there to ask, or
 * the host has a login password for a lone password prompt. Otherwise a server offering it
 * would get an empty answer, which OpenSSH may take as a protocol error and drop the link
 * instead of failing the method, and the checks would end in a timeout rather than an
 * authentication failure.
 */
export function buildConnectConfig(h: SshHost, opts: ConnectAuthOptions = { interactive: false }): ConnectConfig {
  const conf: ConnectConfig = {
    host: h.host,
    port: h.port || 22,
    username: h.username,
    readyTimeout: 120000,
    // A session left idle (its tab in the background while you work in a chat) is what a
    // VPN gateway or a NAT drops first, and the shell channels and every process under
    // them go with it. ssh2 sends nothing on its own; this is `ServerAliveInterval 15` /
    // `ServerAliveCountMax 4` for the ssh CLI — one minute of silence before giving up.
    keepaliveInterval: 15000,
    keepaliveCountMax: 4,
    // Servers that only take keyboard-interactive (PAM, an OTP) are reached after the
    // primary method; the Client's `keyboard-interactive` listener answers (see
    // connectClient), so a config that tries it must never be connected without one.
    tryKeyboard: (opts.interactive && !!opts.askSecret) || (h.authType === 'password' && !!h.password),
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

/**
 * Answers ssh2's keyboard-interactive rounds for `conn`: a lone password prompt gets the
 * known login password (once), anything else goes to `askSecret` when interactive, and fails
 * otherwise (see keyboardInteractiveDecision). The listener belongs on the Client, not the
 * config, hence this helper for every place that dials.
 */
export function attachKeyboardInteractive(conn: Client, knownPassword: string | undefined, opts: ConnectAuthOptions): void {
  let autoAnswered = false
  conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts: KbdPrompt[], finish: (answers: string[]) => void) => {
    const answer = (answers: string[]) => {
      try {
        finish(answers)
      } catch {
        // The connection went away while the user was typing.
      }
    }
    const decision = keyboardInteractiveDecision(prompts, {
      knownPassword,
      autoAnswered,
      interactive: opts.interactive && !!opts.askSecret
    })
    if (decision.kind === 'answer') {
      if (decision.auto) autoAnswered = true
      answer(decision.answers)
      return
    }
    if (decision.kind === 'fail' || !opts.askSecret) {
      answer([])
      return
    }
    const ask = opts.askSecret
    void (async () => {
      const answers: string[] = []
      for (const p of prompts) {
        const v = await ask(p.prompt, !!p.echo)
        if (v === null) return answer([])
        answers.push(v)
      }
      answer(answers)
    })()
  })
}

/** Dials `conn` for `h`: the config plus the keyboard-interactive listener. Throws what
 *  buildConnectConfig or ssh2's connect throws (an unreadable or unparsable key). */
export function connectClient(conn: Client, h: SshHost, opts: ConnectAuthOptions = { interactive: false }): void {
  const conf = buildConnectConfig(h, opts)
  attachKeyboardInteractive(conn, h.authType === 'password' ? h.password || undefined : undefined, opts)
  conn.connect(conf)
}

/**
 * A clearer message for the background checks when the failure is a secret nobody saved: a
 * password host without its password, or an encrypted key without its passphrase. Those
 * hosts are asked for it when a session opens, so "authentication failed" would mislead.
 */
function explainCheckFailure(h: SshHost, message: string): string {
  // Only an authentication failure: an unreachable server must still say so.
  if (h.authType === 'password' && !h.password && /authentication/i.test(message)) return t('main.ssh.noSavedPassword')
  if (h.authType === 'key' && !h.passphrase && keyNeedsPassphrase(message)) return t('main.ssh.noSavedPassphrase')
  return message
}

/** Every saved host with its secrets, for a profile export. A failed read is an error, not
 *  an empty list (see readHosts). */
export function readHostsWithSecrets(): HostsRead<SshHost> {
  return readHosts()
}

/** Replace the saved hosts through `mutate`, re-encrypted for this machine. Fail-closed,
 *  like every other write here. For a profile import. */
export function updateHostsWith(mutate: (hosts: SshHost[]) => SshHost[]): HostsWriteResult {
  return updateHosts(mutate)
}

export function getHost(id: string): SshHost | null {
  return readHostsOrEmpty().find((h) => h.id === id) ?? null
}

/**
 * Build an interactive `ssh` CLI invocation for a stored host, for the embedded terminal
 * to spawn directly (distinct from the headless ssh2 connection `runRemote` uses for
 * one-shot `claude -p` calls). Password auth has no non-interactive flag here — the user
 * is prompted by `ssh` itself inside the terminal.
 *
 * The CLI checks the server against the keys Argos trusts, not `~/.ssh/known_hosts`: an
 * endpoint whose full key is not stored yet goes through testConnection first (the same
 * trust prompt as every other first use), and a server Argos does not trust is an error
 * here rather than a terminal that opens anyway.
 */
export async function getSshTerminalCommand(
  hostId: string
): Promise<{ shell: string; args: string[]; remotePath?: string; claudePath?: string } | null> {
  const h = getHost(hostId)
  if (!h) return null
  // Checked again here, not only on save: a host can arrive through a profile import or a
  // hosts file written by an older version.
  const problem = hostFieldProblem(h)
  if (problem) throw new Error(t(hostFieldProblemKey(problem)))
  const port = h.port || 22
  if (!isEndpointKeyStored(h.host, port)) {
    // The verifier records the key before authentication, so a check that then fails to
    // log in (a password the terminal will ask for) still leaves the server trusted.
    const check = await testConnection(hostId)
    if (!isEndpointKeyStored(h.host, port)) {
      throw new Error(check.ok ? t('main.ssh.notTrusted') : `${t('main.ssh.notTrusted')} (${check.message})`)
    }
  }
  const knownHosts = await trustedKnownHostsPath()
  if (!knownHosts) throw new Error(t('main.ssh.notTrusted'))
  const args: string[] = ['-t']
  if (port !== 22) args.push('-p', String(port))
  if (h.authType === 'key' && h.privateKeyPath) {
    args.push('-i', h.privateKeyPath, '-o', 'IdentitiesOnly=yes')
  }
  // One argv element each, never shell-quoted; sshOptionPath only applies ssh's own
  // option syntax (the userData path can hold spaces, `%` and non-ASCII characters).
  args.push('-o', `UserKnownHostsFile=${sshOptionPath(knownHosts)}`, '-o', 'StrictHostKeyChecking=yes')
  const destination = sshDestinationArgs(h.username, h.host)
  if (!destination) throw new Error(t('main.ssh.invalid.host'))
  args.push(...destination)
  return { shell: 'ssh', args, remotePath: h.remotePath, claudePath: h.claudePath }
}

/** Upper bound for a whole check (handshake + exec); readyTimeout only covers the handshake. */
const CHECK_TIMEOUT_MS = 20_000

/**
 * Does this host accept an SSH connection? Nothing more — it authenticates, reports how
 * long that took, and hangs up. This is what the Remote & WSL list's status dot reflects,
 * so it deliberately does NOT care whether Claude Code is installed: a box can be perfectly
 * reachable without it, and conflating the two meant a green/red dot that answered the wrong
 * question. Use testClaude for that.
 */
export function testConnection(id: string): Promise<{ ok: boolean; message: string }> {
  const host = getHost(id)
  if (!host) return Promise.resolve({ ok: false, message: t('main.ssh.hostNotFound') })

  return new Promise((resolve) => {
    const conn = new Client()
    const startedAt = Date.now()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, message: t('main.ssh.timedOut') }), CHECK_TIMEOUT_MS)
    conn.on('ready', () =>
      done({
        ok: true,
        message: t('main.ssh.connectedAs', { user: host.username, host: host.host, port: host.port, ms: Date.now() - startedAt })
      })
    )
    // Still dialled without a saved password: the host key is recorded before
    // authentication, which getSshTerminalCommand relies on.
    conn.on('error', (e) => done({ ok: false, message: explainCheckFailure(host, e.message) }))
    // A server that drops the link without an error (one that took an unanswered prompt as
    // a protocol error) ends the check now rather than at the timeout. done ignores the close
    // its own conn.end() causes.
    conn.on('close', () => done({ ok: false, message: explainCheckFailure(host, t('main.ssh.closedEarly')) }))
    try {
      connectClient(conn, host)
    } catch (e) {
      done({ ok: false, message: explainCheckFailure(host, e instanceof Error ? e.message : String(e)) })
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
  if (!host) return Promise.resolve({ ok: false, message: t('main.ssh.hostNotFound') })
  const problem = hostFieldProblem(host)
  if (problem) return Promise.resolve({ ok: false, message: t(hostFieldProblemKey(problem)) })

  return new Promise((resolve) => {
    const conn = new Client()
    let settled = false
    const done = (r: { ok: boolean; message: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      conn.end()
      resolve(r)
    }
    const timer = setTimeout(() => done({ ok: false, message: t('main.ssh.timedOut') }), CHECK_TIMEOUT_MS)
    conn.on('ready', () => {
      // exec runs the line through the remote user's shell: the path is one quoted word.
      const claude = host.claudePath ? remoteCommandWord(host.claudePath) : 'claude'
      conn.exec(`${claude} --version`, (err, stream) => {
        if (err) return done({ ok: false, message: t('main.ssh.connectedBut', { error: err.message }) })
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
              message: t('main.ssh.claudeNotFound', { path: host.claudePath || 'claude' })
            })
          }
          done({ ok: false, message: text.slice(0, 300) || t('main.ssh.claudeNoOutput') })
        })
      })
    })
    // Still dialled without a saved password: the host key is recorded before
    // authentication, which getSshTerminalCommand relies on.
    conn.on('error', (e) => done({ ok: false, message: explainCheckFailure(host, e.message) }))
    // A server that drops the link without an error (one that took an unanswered prompt as
    // a protocol error) ends the check now rather than at the timeout. done ignores the close
    // its own conn.end() causes.
    conn.on('close', () => done({ ok: false, message: explainCheckFailure(host, t('main.ssh.closedEarly')) }))
    try {
      connectClient(conn, host)
    } catch (e) {
      done({ ok: false, message: explainCheckFailure(host, e instanceof Error ? e.message : String(e)) })
    }
  })
}
