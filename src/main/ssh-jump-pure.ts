import { hasControlChars, isSafeSshHost, isSafeSshUsername, quotePosix, type SshAuthType } from './ssh-host-pure'

/**
 * Jump hosts (a "gateway"): a saved SSH host reached THROUGH another saved SSH host, as
 * `ssh -J` does. One hop only: a gateway is always dialled directly.
 *
 * `SshHost.jumpHostId` holds the choice:
 *  - absent: no jump of its own. Today that means direct; once host groups land, it means
 *    "inherit the group's gateway", which is why the group's value is a separate input here;
 *  - `''`: explicitly direct, overriding whatever a group would give;
 *  - an id: that saved host is the gateway.
 */

export type JumpSource = 'host' | 'group' | 'none'
export type JumpProblem = 'self' | 'unknown' | 'chained'

export interface JumpRef {
  id: string
  jumpHostId?: string
}

/** Where a host's gateway would come from once groups exist: given a host, its group's
 *  gateway id (or undefined). A callback rather than one value so that the gateway's own
 *  inherited jump can be checked too (a gateway must not have one). */
export type GroupJumpOf<H> = (h: H) => string | undefined

export type JumpResolution<H> =
  | { ok: true; jump: H | null; source: JumpSource }
  | { ok: false; problem: JumpProblem; source: JumpSource; jumpHostId: string }

/** The gateway id a host asks for and where that came from; `''` for direct. */
export function effectiveJumpId<H extends JumpRef>(h: H, groupJumpOf?: GroupJumpOf<H>): { id: string; source: JumpSource } {
  if (typeof h.jumpHostId === 'string') return { id: h.jumpHostId, source: h.jumpHostId ? 'host' : 'none' }
  const fromGroup = groupJumpOf?.(h)
  return fromGroup ? { id: fromGroup, source: 'group' } : { id: '', source: 'none' }
}

/**
 * The gateway a host connects through, or null for direct. Refused (never silently direct,
 * which would send the login to the wrong network): a host that names itself, an id no saved
 * host has, and a gateway that itself has a gateway (one hop only, which also rules out every
 * cycle). Every connect path checks this before dialling, not only the save: a host can arrive
 * through a profile import, and a gateway can be edited or deleted after its riders were saved.
 */
export function resolveJump<H extends JumpRef>(host: H, hosts: readonly H[], groupJumpOf?: GroupJumpOf<H>): JumpResolution<H> {
  const { id, source } = effectiveJumpId(host, groupJumpOf)
  if (!id) return { ok: true, jump: null, source }
  if (id === host.id) return { ok: false, problem: 'self', source, jumpHostId: id }
  const jump = hosts.find((h) => h.id === id)
  if (!jump) return { ok: false, problem: 'unknown', source, jumpHostId: id }
  if (effectiveJumpId(jump, groupJumpOf).id) return { ok: false, problem: 'chained', source, jumpHostId: id }
  return { ok: true, jump, source }
}

export type JumpSaveProblem = JumpProblem | 'isGateway'

/**
 * Checked on save, with `hosts` as they would be after it: the saved host's own jump must
 * resolve, and no host that already goes through it may be left behind a chain (giving a
 * gateway a gateway of its own). `isGateway` names that second case.
 */
export function jumpSaveProblem<H extends JumpRef>(savedId: string, hosts: readonly H[], groupJumpOf?: GroupJumpOf<H>): JumpSaveProblem | null {
  const saved = hosts.find((h) => h.id === savedId)
  if (!saved) return null
  const own = resolveJump(saved, hosts, groupJumpOf)
  if (!own.ok) return own.problem
  if (!effectiveJumpId(saved, groupJumpOf).id) return null
  const riders = hosts.filter((h) => h.id !== savedId && effectiveJumpId(h, groupJumpOf).id === savedId)
  return riders.length > 0 ? 'isGateway' : null
}

/**
 * Checked when a group's gateway changes: the first host whose jump resolved with the groups
 * as they were (`before`) and no longer does with `after`, and why. That covers a group
 * gateway that is itself in the group and would take its own gateway (`self`), a gateway that
 * has one (`chained`), and a server other hosts go through that now inherits a gateway.
 */
export function jumpBreakage<H extends JumpRef>(
  hosts: readonly H[],
  before: GroupJumpOf<H>,
  after: GroupJumpOf<H>
): { hostId: string; problem: JumpProblem; jumpHostId: string } | null {
  for (const h of hosts) {
    if (!resolveJump(h, hosts, before).ok) continue
    const now = resolveJump(h, hosts, after)
    if (!now.ok) return { hostId: h.id, problem: now.problem, jumpHostId: now.jumpHostId }
  }
  return null
}

/** The ids of the hosts that connect through `gatewayId`. */
export function hostIdsUsingJump<H extends JumpRef>(gatewayId: string, hosts: readonly H[], groupJumpOf?: GroupJumpOf<H>): string[] {
  return hosts.filter((h) => h.id !== gatewayId && effectiveJumpId(h, groupJumpOf).id === gatewayId).map((h) => h.id)
}

// ─── The `ssh` CLI: ProxyCommand ─────────────────────────────────────────────

/** The gateway's fields the inner ssh needs. Not secret: a password is typed at its prompt. */
export interface ProxyJumpHost {
  host: string
  port: number
  username: string
  authType: SshAuthType
  privateKeyPath?: string
}

export interface ProxyCommandInput {
  /** The ssh executable the outer ssh is, so both hops run the same client. */
  sshPath: string
  jump: ProxyJumpHost
  /** Argos' trusted known_hosts file. */
  knownHostsPath: string
  /** process.platform: Windows OpenSSH starts the command itself, everything else via sh. */
  platform: string
}

export type ProxyCommandProblem = 'host' | 'username' | 'port' | 'keyPath' | 'knownHosts' | 'sshPath'

export type ProxyCommandResult = { ok: true; command: string } | { ok: false; problem: ProxyCommandProblem }

/**
 * A value that reads the same inside double quotes for both readers a ProxyCommand on
 * Windows can meet: Windows OpenSSH starts it with CreateProcess (the child's C runtime splits
 * the line), while an MSYS ssh (Git for Windows) hands it to `sh -c`. So no `"`, nothing `sh`
 * expands inside double quotes (`$`, a backquote), no backslash that either reader would
 * treat as an escape (before `\`, `"`, `$`, a backquote, or at the very end), no control
 * character, and no `%`: ssh expands `%` tokens in the ProxyCommand and again in the inner
 * ssh's paths, and the two layers do not agree across versions, so it is refused, not escaped.
 */
export function isSafeWindowsProxyWord(v: string): boolean {
  if (!v || hasControlChars(v)) return false
  if (/["$`%]/.test(v)) return false
  if (/\\(?=[\\"$`])/.test(v) || v.endsWith('\\')) return false
  return true
}

/** On sh, single quotes take everything literally; only `%` (ssh's own tokens) and control
 *  characters are refused. */
function isSafePosixProxyWord(v: string): boolean {
  return !!v && !hasControlChars(v) && !v.includes('%')
}

/**
 * The `ProxyCommand` for a host behind `jump`: the same ssh client, run against the gateway
 * with `-W` to the target, under the SAME trust rules as the outer one (Argos' known_hosts,
 * strict checking) and with the gateway's own port and key. Every value is either a fixed
 * word, a validated user/host/port, or a quoted path checked to be safe for the shell that
 * reads it; anything else is refused rather than escaped. Null-free: returns which field is
 * at fault so the caller can say so.
 */
export function buildProxyCommand(input: ProxyCommandInput): ProxyCommandResult {
  const { jump } = input
  const windows = input.platform === 'win32'
  const port = typeof jump.port === 'number' ? jump.port : Number(jump.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, problem: 'port' }
  if (!isSafeSshUsername(jump.username) || jump.username.includes('%')) return { ok: false, problem: 'username' }
  // `%` is refused even where isSafeSshHost allows it (an IPv6 zone): ssh would expand it.
  if (!isSafeSshHost(jump.host) || jump.host.includes('%')) return { ok: false, problem: 'host' }
  const safe = windows ? isSafeWindowsProxyWord : isSafePosixProxyWord
  const quote = windows ? (v: string) => `"${v}"` : quotePosix
  if (!safe(input.sshPath)) return { ok: false, problem: 'sshPath' }
  if (!safe(input.knownHostsPath)) return { ok: false, problem: 'knownHosts' }
  const key = jump.authType === 'key' && jump.privateKeyPath ? jump.privateKeyPath : undefined
  if (key !== undefined && !safe(key)) return { ok: false, problem: 'keyPath' }

  // ssh splits UserKnownHostsFile on spaces, so the path carries ssh's own double quotes
  // inside the shell word: `\"` on Windows (the C runtime and sh both read it as `"`), and
  // plain inside sh's single quotes.
  const knownHostsOpt = windows
    ? `"UserKnownHostsFile=\\"${input.knownHostsPath}\\""`
    : quotePosix(`UserKnownHostsFile="${input.knownHostsPath}"`)
  const parts: string[] = [quote(input.sshPath), '-p', String(port)]
  if (key !== undefined) parts.push('-i', quote(key), '-o', 'IdentitiesOnly=yes')
  parts.push('-o', knownHostsOpt, '-o', 'StrictHostKeyChecking=yes')
  // `[%h]` so an IPv6 target reads as one host; quoted so sh does not take it as a glob.
  parts.push('-W', quote('[%h]:%p'))
  // After `--`, so nothing in it can be read as an option; validated above, quoted anyway
  // (a directory account's `CORP\user` must still read the same to both Windows readers).
  const destination = `${jump.username}@${jump.host}`
  if (!safe(destination)) return { ok: false, problem: 'username' }
  parts.push('--', quote(destination))
  return { ok: true, command: parts.join(' ') }
}
