import type { TFunction } from '../shared/i18n'

export type SshAuthType = 'password' | 'key' | 'agent'

/**
 * Which secret answers sudo/su on a host: `login` reuses the login password (password hosts
 * only), `other` a separate saved elevation password, `none` nothing.
 */
export type ElevationMode = 'login' | 'other' | 'none'

/** The command an "Elevate" action types into the terminal. A fixed list on purpose: it is
 *  typed into a remote shell, so it is never free text. */
export const ELEVATE_COMMANDS = ['sudo -i', 'sudo su -', 'su -'] as const
export type ElevateCommand = (typeof ELEVATE_COMMANDS)[number]
export const DEFAULT_ELEVATE_COMMAND: ElevateCommand = 'sudo -i'

const ELEVATION_MODES: readonly ElevationMode[] = ['login', 'other', 'none']

export function isElevationMode(v: unknown): v is ElevationMode {
  return typeof v === 'string' && (ELEVATION_MODES as readonly string[]).includes(v)
}

export function isElevateCommand(v: unknown): v is ElevateCommand {
  return typeof v === 'string' && (ELEVATE_COMMANDS as readonly string[]).includes(v)
}

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
  elevation?: ElevationMode
  /** Secret. Only kept while `elevation` is `other`, whatever the auth type. */
  elevationPassword?: string
  elevateCommand?: ElevateCommand
}

/**
 * Every secret a saved host can hold, listed once. Whatever strips secrets (the renderer's
 * view of a host, a profile export) works from this list or from PUBLIC_HOST_FIELDS, never
 * by naming fields one by one, so a secret added later cannot slip through a place that
 * was not updated.
 */
export const SECRET_FIELDS = ['password', 'passphrase', 'elevationPassword'] as const
export type SecretField = (typeof SECRET_FIELDS)[number]

/** The fields of a host the renderer may see. An allowlist: a field not named here never
 *  leaves the main process. */
export const PUBLIC_HOST_FIELDS = [
  'id',
  'name',
  'host',
  'port',
  'username',
  'authType',
  'privateKeyPath',
  'remotePath',
  'claudePath',
  'elevation',
  'elevateCommand'
] as const
export type PublicHostField = (typeof PUBLIC_HOST_FIELDS)[number]

// Every SshHost key must be either public or secret: a field added to SshHost without being
// classified here fails the typecheck, instead of leaking or silently vanishing.
type Unclassified = Exclude<keyof SshHost, PublicHostField | SecretField>
const everyHostFieldClassified: [Unclassified] extends [never] ? true : Unclassified = true
void everyHostFieldClassified

export interface HostSecretFlags {
  hasPassword: boolean
  hasPassphrase: boolean
  /** A secret that can answer sudo/su right now: the login password in `login` mode, the
   *  elevation password in `other` mode. */
  hasElevation: boolean
}

/** Host with secrets stripped, safe to hand to the renderer. */
export type SshHostPublic = Pick<SshHost, PublicHostField> & HostSecretFlags

/** The elevation mode in force: an unset or unknown value is `login` for a password host
 *  and `none` otherwise, and `login` on a host that logs in without a password is `none`. */
export function effectiveElevation(h: { authType: SshAuthType; elevation?: unknown }): ElevationMode {
  const mode: ElevationMode = isElevationMode(h.elevation) ? h.elevation : h.authType === 'password' ? 'login' : 'none'
  return mode === 'login' && h.authType !== 'password' ? 'none' : mode
}

/** The elevation command to type, falling back to the default for anything not on the list
 *  (a host from an older version or a profile import never went through cleanHostFields). */
export function elevateCommandFor(h: { elevateCommand?: unknown }): ElevateCommand {
  return isElevateCommand(h.elevateCommand) ? h.elevateCommand : DEFAULT_ELEVATE_COMMAND
}

/** A host as the renderer sees it: the allowlisted fields plus whether each secret exists. */
export function toPublicHost(h: SshHost): SshHostPublic {
  const out: Partial<Record<PublicHostField, unknown>> = {}
  for (const k of PUBLIC_HOST_FIELDS) {
    if (h[k] !== undefined) out[k] = h[k]
  }
  // A host from a profile import or an older version never went through cleanHostFields,
  // so an off-list elevation value is dropped here rather than handed on as typed.
  if (!isElevationMode(out.elevation)) delete out.elevation
  if (!isElevateCommand(out.elevateCommand)) delete out.elevateCommand
  const mode = effectiveElevation(h)
  return {
    ...(out as Pick<SshHost, PublicHostField>),
    hasPassword: !!h.password,
    hasPassphrase: !!h.passphrase,
    hasElevation: (mode === 'login' && !!h.password) || (mode === 'other' && !!h.elevationPassword)
  }
}

/** `h` without any of SECRET_FIELDS. */
export function stripSecrets<T extends object>(h: T): Omit<T, SecretField> {
  const out = { ...h } as Record<string, unknown>
  for (const k of SECRET_FIELDS) delete out[k]
  return out as Omit<T, SecretField>
}

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
  elevation?: string
  elevateCommand?: string
}

/** `input` with its address, name and path fields cleaned, and an elevation mode or command
 *  that is not one of the known values dropped (the command is typed into a remote shell);
 *  everything else is untouched. */
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
  if (input.elevation !== undefined && !isElevationMode(input.elevation)) delete out.elevation
  if (input.elevateCommand !== undefined && !isElevateCommand(input.elevateCommand)) delete out.elevateCommand
  return out
}

/**
 * What a saved host may hold before it reaches the `ssh` CLI's argv or a remote shell.
 * The user and host go into argv as `user@host`, where a leading `-` would be read as an
 * option (`-oProxyCommand=...` runs a local command). The paths are typed into a shell on
 * the far side; a control character there acts on the terminal (Ctrl-C, Enter) even
 * inside quotes, so it is refused rather than quoted.
 */

/** C0 controls, DEL and C1 controls. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function hasControlChars(value: string): boolean {
  return CONTROL.test(value)
}

/** POSIX-style login names, plus `@` and `\` for directory accounts (`user@corp.example`,
 *  `CORP\user`) and a trailing `$` for machine accounts. Never a leading `-`. */
const USERNAME = /^[A-Za-z0-9_.][A-Za-z0-9_.@\\-]*\$?$/

export function isSafeSshUsername(value: string): boolean {
  return value.length > 0 && value.length <= 256 && USERNAME.test(value)
}

/** DNS names (with `_`, which internal zones use) and IPv4, as dot-separated labels that
 *  neither start nor end with `-`; an optional trailing dot. */
const HOSTNAME = /^(?=.{1,253}\.?$)[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?(?:\.[A-Za-z0-9_](?:[A-Za-z0-9_-]*[A-Za-z0-9_])?)*\.?$/
/** IPv6, bare or bracketed, with an optional zone (`fe80::1%eth0`). Loose on purpose: it
 *  only has to keep option-like and shell-special text out, ssh rejects a bad address. */
const IPV6 = /^[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[A-Za-z0-9_.-]+)?$/

export function isSafeSshHost(value: string): boolean {
  if (HOSTNAME.test(value)) return true
  const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
  return bare.length <= 64 && IPV6.test(bare)
}

export type HostFieldProblem = 'username' | 'host' | 'remotePath' | 'claudePath'

/** The first field of a (cleaned) host that may not be used, or null when all are fine. */
export function hostFieldProblem(h: {
  host: string
  username: string
  remotePath?: string
  claudePath?: string
}): HostFieldProblem | null {
  if (!isSafeSshUsername(h.username)) return 'username'
  if (!isSafeSshHost(h.host)) return 'host'
  if (h.remotePath && hasControlChars(h.remotePath)) return 'remotePath'
  if (h.claudePath && hasControlChars(h.claudePath)) return 'claudePath'
  return null
}

/** The i18n key that explains a HostFieldProblem. */
export function hostFieldProblemKey(p: HostFieldProblem): `main.ssh.invalid.${HostFieldProblem}` {
  return `main.ssh.invalid.${p}`
}

/** The `ssh` CLI's destination, after `--` so that nothing in it can be read as an option.
 *  Null when the user or host would not pass hostFieldProblem. */
export function sshDestinationArgs(username: string, host: string): string[] | null {
  if (!isSafeSshUsername(username) || !isSafeSshHost(host)) return null
  return ['--', `${username}@${host}`]
}

/** POSIX single-quoting: `'...'`, each `'` written as `'\''`. */
export function quotePosix(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A configured command path (the host's claude) as one word for a POSIX shell. A leading
 * `~/` stays outside the quotes so the remote shell still expands it to the user's home,
 * the usual spelling for a per-user install (`~/.local/bin/claude`).
 */
export function remoteCommandWord(path: string): string {
  return path.startsWith('~/') ? `~/${quotePosix(path.slice(2))}` : quotePosix(path)
}

export type HostSecrets = Partial<Record<SecretField, string>>

/**
 * The secrets a saved host ends up with. For each field: `undefined` (or an empty string)
 * keeps the stored value, `null` clears it, a non-empty string replaces it. A secret the
 * host's settings do not use is dropped, so switching leaves nothing stale: the password and
 * passphrase follow the auth type, and the elevation password follows the elevation mode
 * (`other`) whatever the auth type.
 */
export function mergeSecrets(
  prev: HostSecrets | undefined,
  input: {
    authType: SshAuthType
    elevation?: string
    password?: string | null
    passphrase?: string | null
    elevationPassword?: string | null
  }
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
  if (input.elevation === 'other') {
    const v = pick(input.elevationPassword, prev?.elevationPassword)
    if (v) out.elevationPassword = v
  }
  return out
}

interface ConnectionFields {
  host: string
  port?: number
  username: string
  authType: SshAuthType
  privateKeyPath?: string
}

/**
 * Did an edit change what a pooled connection to the host was opened with? True when the
 * address, port, user, auth type or key path differ, or a login secret was cleared (`null`)
 * or replaced (non-empty string). Text is compared after cleaning, as it is saved. The
 * elevation settings and password are left out on purpose: they are only typed into a
 * terminal later, so changing them must not drop a live session.
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
