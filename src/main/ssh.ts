import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { Client, ConnectConfig } from 'ssh2'
import { randomUUID } from 'crypto'
import { isEndpointKeyStored, trustedKnownHostsPath, verifyHostKey } from './ssh-trust'
import { sshOptionPath } from './ssh-trust-pure'
import { t } from './i18n'
import { plural } from '../shared/i18n'
import { keyboardInteractiveDecision, keyNeedsPassphrase, type KbdPrompt } from './connect-auth-pure'
import { createEncryptedListStore } from './encrypted-list-store'
import {
  cleanHostFields,
  hostFieldProblem,
  hostFieldProblemKey,
  mergeSecrets,
  stripSecrets,
  toPublicHost,
  remoteCommandWord,
  sshDestinationArgs,
  type HostsRead,
  type SecretField,
  type SshHost,
  type SshHostPublic
} from './ssh-host-pure'
import {
  cleanCredentialFields,
  credentialFieldProblem,
  credentialUsage,
  resolveHostAuth,
  stripCredentialAuth,
  toPublicCredential,
  withCredentialInfo,
  type EffectiveSshHost,
  type SshCredential,
  type SshCredentialInput,
  type SshCredentialPublic,
  type StoredSshHost
} from './ssh-credential-pure'
import { checkForwards, forwardProblemKey, usableForwards, type PortForward } from './port-forwards-pure'

export type { SshAuthType, SshHost, SshHostPublic } from './ssh-host-pure'
export type { EffectiveSshHost, SshCredential, SshCredentialInput, SshCredentialPublic, StoredSshHost } from './ssh-credential-pure'

/** What the renderer sends: `undefined` keeps a stored secret, `null` clears it. A host with
 *  `credentialId` set takes its login from that credential; its own login fields are ignored. */
export type SshHostInput = Omit<SshHost, 'id' | SecretField> & {
  id?: string
} & { [K in SecretField]?: string | null }

const hostStore = createEncryptedListStore<StoredSshHost>(path.join(app.getPath('userData'), 'ssh-hosts.bin'), 'ssh', {
  unreadable: 'main.ssh.hostsUnreadable',
  saveFailed: 'main.ssh.hostsSaveFailed'
})

const credentialStore = createEncryptedListStore<SshCredential>(path.join(app.getPath('userData'), 'ssh-credentials.bin'), 'ssh', {
  unreadable: 'main.ssh.credentialsUnreadable',
  saveFailed: 'main.ssh.credentialsSaveFailed'
})

export type HostsWriteResult = { ok: true; hosts: SshHostPublic[] } | { ok: false; error: string }

function updateHosts(mutate: (hosts: StoredSshHost[]) => StoredSshHost[]): HostsWriteResult {
  const res = hostStore.update(mutate)
  return res.ok ? { ok: true, hosts: listHosts() } : res
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

/** The hosts as the renderer sees them: the login each one really uses (its own or its
 *  credential's), never a secret, plus the name of a linked credential. */
export function listHosts(): SshHostPublic[] {
  const credentials = credentialStore.readOrEmpty()
  return hostStore.readOrEmpty().map((h) => {
    // Forwards are re-checked on the way out: an imported host never went through saveHost.
    const own = h.forwards === undefined ? h : { ...h, forwards: usableForwards(h.forwards) }
    const eff = resolveHostAuth(own, credentials)
    return withCredentialInfo(toPublicHost(eff), eff)
  })
}

function genId(): string {
  return `ssh_${randomUUID()}`
}

function genCredentialId(): string {
  return `cred_${randomUUID()}`
}

/** The forwards a host is saved with, or the save's error naming the tunnel at fault. */
function checkedForwards(value: unknown): { ok: true; forwards: PortForward[] } | { ok: false; error: string } {
  const res = checkForwards(value)
  if (res.ok) return res
  return { ok: false, error: t(forwardProblemKey(res.problem), { n: (res.index ?? 0) + 1 }) }
}

export function saveHost(raw: SshHostInput): HostsWriteResult {
  const credentialId = typeof raw.credentialId === 'string' && raw.credentialId ? raw.credentialId : undefined
  if (credentialId) return saveLinkedHost(raw, credentialId)
  const cleaned = stripSecrets(cleanHostFields({ ...raw, username: typeof raw.username === 'string' ? raw.username : '' }))
  // Unlinked: a credential id the input carried is dropped.
  const fields: Omit<typeof cleaned, 'credentialId'> & { credentialId?: string } = { ...cleaned }
  delete fields.credentialId
  const problem = hostFieldProblem(fields)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  const forwards = checkedForwards(raw.forwards)
  if (!forwards.ok) return forwards
  if (forwards.forwards.length) fields.forwards = forwards.forwards
  else delete fields.forwards
  return updateHosts((hosts) => {
    const idx = fields.id ? hosts.findIndex((h) => h.id === fields.id) : -1
    // A host that was linked has no secrets of its own to keep.
    const prev = idx >= 0 && !hosts[idx].credentialId ? hosts[idx] : undefined
    const secrets = mergeSecrets(prev, raw)
    if (idx >= 0) {
      hosts[idx] = { ...fields, id: fields.id as string, ...secrets }
    } else {
      hosts.push({ ...fields, id: fields.id || genId(), ...secrets })
    }
    return hosts
  })
}

/** A host that logs in with a shared credential: only its own fields are kept (address,
 *  name, paths, organisation), never a login or a secret. */
function saveLinkedHost(raw: SshHostInput, credentialId: string): HostsWriteResult {
  const creds = credentialStore.read()
  if (!creds.ok) return { ok: false, error: t('main.ssh.credentialsUnreadable', { error: creds.error, file: credentialStore.file }) }
  const cred = creds.hosts.find((c) => c.id === credentialId)
  if (!cred) return { ok: false, error: t('main.ssh.credentialMissing') }
  // Cleaned with the credential's username in place, so the checks below see the login
  // the host will really use.
  const cleaned = cleanHostFields({ ...raw, username: cred.username })
  const problem = hostFieldProblem(cleaned)
  if (problem) return { ok: false, error: t(hostFieldProblemKey(problem)) }
  const forwards = checkedForwards(raw.forwards)
  if (!forwards.ok) return forwards
  const fields = { ...stripCredentialAuth(cleaned), credentialId }
  if (forwards.forwards.length) fields.forwards = forwards.forwards
  else delete fields.forwards
  return updateHosts((hosts) => {
    const idx = fields.id ? hosts.findIndex((h) => h.id === fields.id) : -1
    if (idx >= 0) hosts[idx] = { ...fields, id: fields.id as string }
    else hosts.push({ ...fields, id: fields.id || genId() })
    return hosts
  })
}

export function deleteHost(id: string): HostsWriteResult {
  return updateHosts((hosts) => hosts.filter((h) => h.id !== id))
}

/**
 * Saves a login password typed at the connect prompt with "save" ticked. Only the password
 * field changes, on a fresh read of the store (fail-closed like every write here), and only
 * while the host still exists and still logs in with a password of its own: the form may have
 * changed it while the prompt was up, and a host linked to a shared credential never stores
 * one (the prompt does not offer to save for it). Not through saveHost, whose callers close
 * the pooled connection when a password is touched, and this one has just been opened with
 * it. Not ok when nothing was saved, so the caller keeps the password for the session.
 */
export function saveHostPassword(id: string, password: string): HostsWriteResult {
  let saved = false
  const res = updateHosts((hosts) =>
    hosts.map((h) => {
      if (h.id !== id || h.credentialId || h.authType !== 'password') return h
      saved = true
      return { ...h, password }
    })
  )
  if (res.ok && !saved) return { ok: false, error: t('main.ssh.hostNotFound') }
  return res
}

// ─── Shared credentials ─────────────────────────────────────────────────────

export type CredentialsWriteResult = { ok: true; credentials: SshCredentialPublic[] } | { ok: false; error: string }

/** The credentials as the renderer sees them: no secrets, and how many hosts link each. */
export function listCredentials(): SshCredentialPublic[] {
  const hosts = hostStore.readOrEmpty()
  return credentialStore.readOrEmpty().map((c) => toPublicCredential(c, credentialUsage(hosts, c.id)))
}

/** One saved credential with its secrets, for main only (comparing before and after a save). */
export function getStoredCredential(id: string): SshCredential | null {
  return credentialStore.readOrEmpty().find((c) => c.id === id) ?? null
}

/** The ids of the hosts linked to credential `id`. */
export function hostIdsUsingCredential(id: string): string[] {
  return hostStore
    .readOrEmpty()
    .filter((h) => h.credentialId === id)
    .map((h) => h.id)
}

/** Same keep / clear / replace rules for its secrets as a host (mergeSecrets). */
export function saveCredential(raw: SshCredentialInput): CredentialsWriteResult {
  const fields = stripSecrets(cleanCredentialFields(raw))
  const problem = credentialFieldProblem(fields)
  if (problem) {
    const key =
      problem === 'name' ? 'main.ssh.credentialNameMissing' : problem === 'username' ? 'main.ssh.invalid.username' : 'main.ssh.credentialAuthInvalid'
    return { ok: false, error: t(key) }
  }
  const res = credentialStore.update((creds) => {
    const idx = fields.id ? creds.findIndex((c) => c.id === fields.id) : -1
    const prev = idx >= 0 ? creds[idx] : undefined
    const secrets = mergeSecrets(prev, raw)
    if (idx >= 0) creds[idx] = { ...fields, id: fields.id as string, ...secrets }
    else creds.push({ ...fields, id: fields.id || genCredentialId(), ...secrets })
    return creds
  })
  return res.ok ? { ok: true, credentials: listCredentials() } : res
}

/**
 * Deletes a credential no host links. One still in use is refused rather than unlinked: those
 * hosts would be left with no login at all. Read strictly: an unreadable hosts file must not
 * pass for "no host uses it".
 */
export function deleteCredential(id: string): CredentialsWriteResult {
  const hosts = hostStore.read()
  if (!hosts.ok) return { ok: false, error: t('main.ssh.hostsUnreadable', { error: hosts.error, file: hostStore.file }) }
  const used = credentialUsage(hosts.hosts, id)
  if (used > 0) return { ok: false, error: plural(t, 'main.ssh.credentialInUse', used) }
  const res = credentialStore.update((creds) => creds.filter((c) => c.id !== id))
  return res.ok ? { ok: true, credentials: listCredentials() } : res
}

/** Every saved credential with its secrets, for a profile export. A failed read is an error. */
export function readCredentialsWithSecrets(): HostsRead<SshCredential> {
  return credentialStore.read()
}

/** Replace the saved credentials through `mutate`, fail-closed. For a profile import. */
export function updateCredentialsWith(mutate: (creds: SshCredential[]) => SshCredential[]): CredentialsWriteResult {
  const res = credentialStore.update(mutate)
  return res.ok ? { ok: true, credentials: listCredentials() } : res
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
export function buildConnectConfig(h: EffectiveSshHost, opts: ConnectAuthOptions = { interactive: false }): ConnectConfig {
  // A host whose shared credential is gone has no login at all: say so, rather than dial
  // with an empty password.
  if (h.credentialMissing) throw new Error(t('main.ssh.credentialMissing'))
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
export function connectClient(conn: Client, h: EffectiveSshHost, opts: ConnectAuthOptions = { interactive: false }): void {
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

/** Every saved host as stored (a linked one without a login of its own), with its secrets,
 *  for a profile export. A failed read is an error, not an empty list. */
export function readHostsWithSecrets(): HostsRead<StoredSshHost> {
  return hostStore.read()
}

/** Replace the saved hosts through `mutate`, re-encrypted for this machine. Fail-closed,
 *  like every other write here. For a profile import. */
export function updateHostsWith(mutate: (hosts: StoredSshHost[]) => StoredSshHost[]): HostsWriteResult {
  return updateHosts(mutate)
}

/**
 * A saved host as it logs in: its login resolved through its shared credential, if it links
 * one (resolveHostAuth). What every connecting path uses, so none of them has to know about
 * credentials. A host whose credential is gone comes back marked `credentialMissing`, and the
 * connect paths refuse it.
 */
export function getHost(id: string): EffectiveSshHost | null {
  const h = getStoredHost(id)
  return h ? resolveHostAuth(h, credentialStore.readOrEmpty()) : null
}

/** A saved host exactly as stored: a linked one has no login of its own. For the paths that
 *  edit or copy the record itself, never for connecting. */
export function getStoredHost(id: string): StoredSshHost | null {
  return hostStore.readOrEmpty().find((h) => h.id === id) ?? null
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
  if (h.credentialMissing) throw new Error(t('main.ssh.credentialMissing'))
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
  if (host.credentialMissing) return Promise.resolve({ ok: false, message: t('main.ssh.credentialMissing') })

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
  if (host.credentialMissing) return Promise.resolve({ ok: false, message: t('main.ssh.credentialMissing') })
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
