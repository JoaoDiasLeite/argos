import { resolveJump, type GroupJumpOf, type JumpProblem, type JumpRef, type JumpSource } from './ssh-jump-pure'
import { cleanHostText, hasControlChars, quotePosix } from './ssh-host-pure'

/**
 * VPNs that run on a gateway VM (a saved SSH host other servers go through, ssh-jump-pure.ts).
 * Each profile says how to bring one client's VPN up and down and how to tell whether it is
 * up. For the presets Argos builds the command from a validated name; a `custom` profile holds
 * the user's own shell lines for their own VM, run as written. Not secret: `vpns` is on the
 * host's public allowlist.
 */

export type VpnKind = 'openvpn' | 'wireguard' | 'nmcli' | 'openfortivpn' | 'custom'
export const VPN_KINDS: readonly VpnKind[] = ['openvpn', 'wireguard', 'nmcli', 'openfortivpn', 'custom']

export interface VpnProfile {
  id: string
  /** What the user calls it ("Câmara X"). */
  name: string
  kind: VpnKind
  /** The presets' unit, config or connection name. */
  target?: string
  /** `custom` only: the user's own shell lines. Exit 0 from `status` means up. */
  up?: string
  down?: string
  status?: string
  /** Run up and down (and a custom status) through sudo. Unset: on for the presets, off for
   *  `custom`. */
  sudo?: boolean
}

export type VpnAction = 'up' | 'down' | 'status'

export const MAX_VPNS = 20
export const MAX_VPN_NAME = 80
export const MAX_VPN_COMMAND = 500

/** Ids come from the renderer (crypto.randomUUID) and only key lists and events. */
const VPN_ID = /^[A-Za-z0-9_-]{1,64}$/
/**
 * A preset's target: a systemd instance name, a WireGuard interface or config name, or a
 * NetworkManager connection id. Never a leading `-`: quoting keeps the shell out, but
 * `wg-quick up -x` or `ip link show -x` would still read it as an option.
 */
const VPN_TARGET = /^[A-Za-z0-9_.@][A-Za-z0-9_.@-]{0,63}$/

export function isVpnKind(v: unknown): v is VpnKind {
  return typeof v === 'string' && (VPN_KINDS as readonly string[]).includes(v)
}

export function isSafeVpnTarget(v: unknown): v is string {
  return typeof v === 'string' && VPN_TARGET.test(v)
}

export function isVpnId(v: unknown): v is string {
  return typeof v === 'string' && VPN_ID.test(v)
}

/** A custom command: non-empty, at most 500 characters, one line (a control character, a
 *  newline included, would act on the shell in ways the form does not show). */
export function isUsableCustomCommand(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= MAX_VPN_COMMAND && !hasControlChars(v)
}

/** Whether `action` on `vpn` runs through sudo. A preset's status never does: systemctl
 *  is-active, ip link and nmcli all answer an unprivileged user. */
export function vpnUsesSudo(vpn: Pick<VpnProfile, 'kind' | 'sudo'>, action: VpnAction): boolean {
  if (vpn.kind !== 'custom' && action === 'status') return false
  return vpn.sudo ?? vpn.kind !== 'custom'
}

/**
 * The shell line for `action` on `vpn`, before any sudo, or null when the profile cannot
 * build one (a bad target, a missing custom command). The presets put nothing but the quoted,
 * validated target into a fixed command; a custom profile's line is the user's own, as typed.
 *
 * openvpn uses the `openvpn-client@` template (the packaged one for client configs in
 * /etc/openvpn/client); openfortivpn expects an `openfortivpn@` template unit, which the
 * package ships on some distributions only.
 */
export function vpnCommand(vpn: VpnProfile, action: VpnAction): string | null {
  if (vpn.kind === 'custom') {
    const line = action === 'up' ? vpn.up : action === 'down' ? vpn.down : vpn.status
    return isUsableCustomCommand(line) ? line.trim() : null
  }
  if (!isSafeVpnTarget(vpn.target)) return null
  const target = quotePosix(vpn.target)
  switch (vpn.kind) {
    case 'openvpn':
    case 'openfortivpn': {
      const unit = quotePosix(`${vpn.kind === 'openvpn' ? 'openvpn-client' : 'openfortivpn'}@${vpn.target}`)
      const verb = action === 'up' ? 'start' : action === 'down' ? 'stop' : 'is-active'
      return `systemctl ${verb} ${unit}`
    }
    case 'wireguard':
      return action === 'status' ? `ip link show dev ${target}` : `wg-quick ${action} ${target}`
    case 'nmcli':
      // `-t` prints one bare name per line; readStatus looks for the exact line. Not piped to
      // grep here: a pipe's exit code is grep's, and a missing nmcli would read as "down".
      return action === 'status' ? `nmcli -t -f NAME connection show --active` : `nmcli connection ${action} id ${target}`
    default:
      return null
  }
}

/**
 * What a finished status command says. Exit 126 or 127 is the shell's "cannot run" or "not
 * found" (no systemd, no wg on the gateway): an error, never "down". nmcli is up when its
 * active list has the target as a whole line, and an error when it fails (NetworkManager not
 * running). Every other kind is up on exit 0 and down otherwise.
 */
export function readStatus(vpn: VpnProfile, code: number, output: string): 'up' | 'down' | 'missing' | 'error' {
  if (code === 126 || code === 127) return 'missing'
  if (vpn.kind === 'nmcli') {
    if (code !== 0) return 'error'
    return output.split(/\r?\n/).some((l) => l === vpn.target) ? 'up' : 'down'
  }
  return code === 0 ? 'up' : 'down'
}

// ─── Validation ─────────────────────────────────────────────────────────────

export type VpnProblem = 'tooMany' | 'id' | 'name' | 'kind' | 'target' | 'up' | 'down' | 'status'

export type VpnsCheck = { ok: true; vpns: VpnProfile[] } | { ok: false; problem: VpnProblem; /** 0-based, absent for `tooMany`. */ index?: number }

/** One profile as it is saved, or the first thing wrong with it. Only the fields its kind
 *  uses are kept, so switching kinds in the form leaves nothing stale behind. */
function cleanVpn(raw: unknown): VpnProfile | Exclude<VpnProblem, 'tooMany'> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'id'
  const v = raw as Record<string, unknown>
  if (!isVpnId(v.id)) return 'id'
  const name = typeof v.name === 'string' ? cleanHostText(v.name).slice(0, MAX_VPN_NAME).trim() : ''
  if (!name || hasControlChars(name)) return 'name'
  if (!isVpnKind(v.kind)) return 'kind'
  const out: VpnProfile = { id: v.id, name, kind: v.kind }
  if (v.kind === 'custom') {
    for (const k of ['up', 'down', 'status'] as const) {
      const line = typeof v[k] === 'string' ? (v[k] as string).trim() : ''
      if (!isUsableCustomCommand(line)) return k
      out[k] = line
    }
  } else {
    const target = typeof v.target === 'string' ? cleanHostText(v.target) : ''
    if (!isSafeVpnTarget(target)) return 'target'
    out.target = target
  }
  if (typeof v.sudo === 'boolean') out.sudo = v.sudo
  return out
}

/** The profiles a gateway is saved with, or why they cannot be. Absent is none; ids must be
 *  unique, as they key the servers that need them. */
export function checkVpns(value: unknown): VpnsCheck {
  if (value === undefined || value === null) return { ok: true, vpns: [] }
  if (!Array.isArray(value)) return { ok: false, problem: 'id', index: 0 }
  if (value.length > MAX_VPNS) return { ok: false, problem: 'tooMany' }
  const vpns: VpnProfile[] = []
  const ids = new Set<string>()
  for (let i = 0; i < value.length; i++) {
    const v = cleanVpn(value[i])
    if (typeof v === 'string') return { ok: false, problem: v, index: i }
    if (ids.has(v.id)) return { ok: false, problem: 'id', index: i }
    ids.add(v.id)
    vpns.push(v)
  }
  return { ok: true, vpns }
}

/** The profiles that pass, the others dropped: what a host from an import or an older file
 *  (which never went through the save's check) may use. Re-checked at every run as well. */
export function usableVpns(value: unknown): VpnProfile[] {
  if (!Array.isArray(value)) return []
  const out: VpnProfile[] = []
  for (const raw of value.slice(0, MAX_VPNS)) {
    const v = cleanVpn(raw)
    if (typeof v !== 'string' && !out.some((x) => x.id === v.id)) out.push(v)
  }
  return out
}

export function vpnProblemKey(p: VpnProblem): `main.vpn.invalid.${VpnProblem}` {
  return `main.vpn.invalid.${p}`
}

// ─── Which VPN a server needs ───────────────────────────────────────────────

/** A host as the resolver reads it. `vpnId` follows the jump's convention: absent inherits
 *  the group's, `''` is explicitly none, an id is a profile on the resolved gateway. */
export interface VpnHostRef extends JumpRef {
  vpnId?: string
  vpnAutoUp?: boolean
  vpns?: unknown
}

/** A host's group's VPN choice, as GroupJumpOf is for the gateway. */
export type GroupVpnOf<H> = (h: H) => { vpnId?: string; vpnAutoUp?: boolean } | undefined

export type VpnSource = 'host' | 'group' | 'none'
export type VpnResolveProblem = JumpProblem | 'vpnNoGateway' | 'vpnMissing'

export type VpnResolution<H> =
  | { ok: true; jump: H | null; jumpSource: JumpSource; vpn: VpnProfile | null; autoUp: boolean; vpnSource: VpnSource }
  | { ok: false; problem: VpnResolveProblem; jumpHostId?: string; vpnId?: string; vpnSource: VpnSource }

/** The VPN id a host asks for and where it came from; `''` for none. */
export function effectiveVpnId<H extends VpnHostRef>(h: H, groupVpnOf?: GroupVpnOf<H>): { id: string; source: VpnSource; autoUp: boolean } {
  if (typeof h.vpnId === 'string') return { id: h.vpnId, source: h.vpnId ? 'host' : 'none', autoUp: h.vpnId ? h.vpnAutoUp === true : false }
  const g = groupVpnOf?.(h)
  return g?.vpnId ? { id: g.vpnId, source: 'group', autoUp: g.vpnAutoUp === true } : { id: '', source: 'none', autoUp: false }
}

/**
 * resolveJump, plus the VPN the host needs on that gateway and whether to bring it up without
 * asking (`autoUp` comes from wherever the VPN choice came from: the host's own, or its
 * group's). A VPN asked for that cannot be found (no gateway, or none of the gateway's
 * profiles has the id) is refused, never ignored: connecting without it would dial a client's
 * private address on whatever network the gateway happens to be on.
 */
export function resolveVpn<H extends VpnHostRef>(
  host: H,
  hosts: readonly H[],
  groupJumpOf?: GroupJumpOf<H>,
  groupVpnOf?: GroupVpnOf<H>
): VpnResolution<H> {
  const want = effectiveVpnId(host, groupVpnOf)
  const jump = resolveJump(host, hosts, groupJumpOf)
  if (!jump.ok) return { ok: false, problem: jump.problem, jumpHostId: jump.jumpHostId, vpnSource: want.source }
  if (!want.id) return { ok: true, jump: jump.jump, jumpSource: jump.source, vpn: null, autoUp: false, vpnSource: 'none' }
  if (!jump.jump) return { ok: false, problem: 'vpnNoGateway', vpnId: want.id, vpnSource: want.source }
  const vpn = usableVpns(jump.jump.vpns).find((v) => v.id === want.id)
  if (!vpn) return { ok: false, problem: 'vpnMissing', jumpHostId: jump.jump.id, vpnId: want.id, vpnSource: want.source }
  return { ok: true, jump: jump.jump, jumpSource: jump.source, vpn, autoUp: want.autoUp, vpnSource: want.source }
}

/** Checked on save: the host's OWN VPN choice must name a profile on its gateway. An
 *  inherited one that does not fit is left to the connect, which refuses it with a message,
 *  as the group may be fixed later. */
export function vpnSaveProblem<H extends VpnHostRef>(
  savedId: string,
  hosts: readonly H[],
  groupJumpOf?: GroupJumpOf<H>,
  groupVpnOf?: GroupVpnOf<H>
): 'vpnNoGateway' | 'vpnMissing' | null {
  const saved = hosts.find((h) => h.id === savedId)
  if (!saved || !saved.vpnId) return null
  const res = resolveVpn(saved, hosts, groupJumpOf, groupVpnOf)
  if (res.ok || (res.problem !== 'vpnNoGateway' && res.problem !== 'vpnMissing')) return null
  return res.problem
}

/** The group's VPN must be one of its gateway's profiles; none is fine. */
export function groupVpnProblem<H extends JumpRef & { vpns?: unknown }>(
  group: { jumpHostId?: string; vpnId?: string },
  hosts: readonly H[]
): 'vpnNoGateway' | 'vpnMissing' | null {
  if (!group.vpnId) return null
  if (!group.jumpHostId) return 'vpnNoGateway'
  const gw = hosts.find((h) => h.id === group.jumpHostId)
  return gw && usableVpns(gw.vpns).some((v) => v.id === group.vpnId) ? null : 'vpnMissing'
}

// ─── sudo over stdin ────────────────────────────────────────────────────────

/** Printed by the wrapped shell before the command, so its presence proves sudo let the
 *  command run: sudo's own failures and the command's exit with the same code 1. */
export const RAN_MARKER = '__ARGOS_VPN_RAN__'

/** `sh -c` around the command, the marker first. */
function wrapped(cmd: string): string {
  return `sh -c ${quotePosix(`echo ${RAN_MARKER}; ${cmd}`)}`
}

/** First try: sudo that never asks (`-n`); cached or NOPASSWD rights run the command at once,
 *  and nothing secret is written anywhere. C locale so sudo's own messages can be read. */
export function sudoProbeLine(cmd: string): string {
  return `env LC_ALL=C sudo -n -- ${wrapped(cmd)}`
}

/** Second try, once sudo said it needs a password: read it from stdin (`-S`), with no prompt
 *  text (`-p ''`) and ignoring any cached rights (`-k`), so the line written to stdin is
 *  always taken as the password and never reaches the command. */
export function sudoStdinLine(cmd: string): string {
  return `env LC_ALL=C sudo -S -p '' -k -- ${wrapped(cmd)}`
}

/** A command that needs no sudo, still wrapped so a custom line runs in sh whatever the
 *  login shell is. */
export function plainLine(cmd: string): string {
  return wrapped(cmd)
}

export interface ExecOutcome {
  code: number | null
  stdout: string
  stderr: string
}

export type SudoStep =
  /** The command ran: its exit code and its output, the marker taken out. */
  | { kind: 'ran'; code: number | null; output: string }
  /** sudo wants a password and there is one to give: run sudoStdinLine. */
  | { kind: 'retry-with-secret' }
  /** sudo wants a password and the gateway has no elevation secret. */
  | { kind: 'needs-password' }
  /** The secret given was refused. Never retried: repeated failures can lock the account. */
  | { kind: 'wrong-password'; output: string }
  /** sudo refused for another reason (not in sudoers, needs a tty). */
  | { kind: 'sudo-error'; output: string }

const NEEDS_PASSWORD = /a password is required|a terminal is required/i
const WRONG_PASSWORD = /incorrect password|sorry, try again|no password was provided|authentication failure|password attempts?/i

/** Where the marker sits in stdout, and the output without it. */
function splitMarker(stdout: string): { ran: boolean; rest: string } {
  const lines = stdout.split(/\r?\n/)
  const i = lines.findIndex((l) => l.trim() === RAN_MARKER)
  if (i < 0) return { ran: false, rest: stdout }
  lines.splice(i, 1)
  return { ran: true, rest: lines.join('\n') }
}

function joined(stdout: string, stderr: string): string {
  return [stdout, stderr].filter((s) => s.trim()).join('\n')
}

/**
 * What to do after a sudo run, from the marker and sudo's own messages, never from the exit
 * code alone: `test -f` on a missing file and a refused password both exit 1, and a sudo
 * failure must never pass for "the VPN is down".
 */
export function sudoStep(phase: 'probe' | 'stdin', res: ExecOutcome, hasSecret: boolean): SudoStep {
  const m = splitMarker(res.stdout)
  if (m.ran) return { kind: 'ran', code: res.code, output: joined(m.rest, res.stderr) }
  const text = joined(res.stdout, res.stderr)
  if (phase === 'probe') {
    if (NEEDS_PASSWORD.test(res.stderr)) return hasSecret ? { kind: 'retry-with-secret' } : { kind: 'needs-password' }
    return { kind: 'sudo-error', output: text }
  }
  if (WRONG_PASSWORD.test(res.stderr)) return { kind: 'wrong-password', output: text }
  return { kind: 'sudo-error', output: text }
}

/** A run without sudo: the marker taken out, the command's code kept. Without the marker the
 *  shell itself did not start. */
export function plainStep(res: ExecOutcome): { ran: boolean; code: number | null; output: string } {
  const m = splitMarker(res.stdout)
  return { ran: m.ran, code: res.code, output: joined(m.rest, res.stderr) }
}

// ─── Output ─────────────────────────────────────────────────────────────────

export const MAX_VPN_OUTPUT = 2048

// CSI and OSC sequences, then any other lone escape.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/**
 * Output safe to show: escapes stripped, every secret given replaced (before cutting, so a
 * secret is never left half visible at the cut), then the last ~2 KB, trimmed. The secret is
 * written to sudo's stdin and should never come back; this is the guard in case a command
 * echoes its input.
 */
export function scrubOutput(text: string, secrets: readonly (string | undefined)[] = [], max = MAX_VPN_OUTPUT): string {
  let out = text.replace(ANSI, '').replace(/\r\n?/g, '\n')
  for (const s of secrets) {
    if (s && s.length > 0) out = out.split(s).join('••••')
  }
  out = out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  out = out.trim()
  if (out.length > max) out = `…${out.slice(out.length - max + 1)}`
  return out.trim()
}
