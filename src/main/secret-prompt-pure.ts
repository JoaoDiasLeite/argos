import { effectiveElevation, type SshAuthType } from './ssh-host-pure'

/**
 * Pure helpers behind the Remote Session terminal's "Send password" and "Elevate" actions
 * (src/main/remote-shell.ts). Main keeps a short, escape-free tail of each host shell's output
 * and looks at its last visible line to decide whether the shell is sitting at a password
 * prompt. The detection only ever gates a click or answers the one prompt an Elevate click
 * provoked: the text comes from the remote side, so a `cat` of a file that contains
 * "[sudo] password for joao:" must never be enough on its own to hand a secret over.
 */

export type SecretPromptKind = 'sudo' | 'login' | 'passphrase'

export interface SecretPromptMatch {
  kind: SecretPromptKind
  /** A bare `Password:` (su, a sudo with a custom prompt, a nested login): which secret it
   *  wants is a guess, so the choice falls back from the elevation secret to the login one. */
  ambiguous: boolean
}

/** How much stripped output a shell keeps. A prompt is one short line; this is plenty. */
export const TAIL_MAX = 300

// OSC (`ESC ] … BEL` or `ESC ] … ESC \`), CSI (`ESC [ params final`), DCS/SOS/PM/APC strings
// (`ESC P|X|^|_ … ESC \`), then any other escape (intermediates plus one final byte). The last
// rule leaves out `[`, `]`, `P`, `X`, `^` and `_` so an unfinished CSI or OSC at the end of a
// chunk survives untouched, and is removed whole once the next chunk completes it.
const ESCAPES_RE =
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[PX^_][\s\S]*?\x1b\\|\x1b[ -/]*[0-OQ-WYZ\\`a-~]/g
// Other C0 controls (bell, backspace, shift-in/out…) and DEL. ESC is kept for the reason above,
// and tab, LF and CR are kept because the line logic reads them.
const CONTROLS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f]/g

/** `s` without terminal escape sequences or stray control characters. An escape sequence that
 *  is still unfinished at the end of `s` is left in place (see ESCAPES_RE). */
export function stripAnsi(s: string): string {
  return s.replace(ESCAPES_RE, '').replace(CONTROLS_RE, '')
}

/**
 * The tail after `chunk` arrives: the stripped output, cut to its last `max` characters. Only
 * the end of a large chunk is looked at (a `cat` of a big file arrives in 32 KB pieces), and
 * then the old tail is dropped, since it no longer sits next to what is kept.
 */
export function appendTail(tail: string, chunk: string, max: number = TAIL_MAX): string {
  const window = max * 4
  const raw = chunk.length > window ? chunk.slice(-window) : tail + chunk
  const clean = stripAnsi(raw)
  return clean.length > max ? clean.slice(-max) : clean
}

/** The line the cursor sits on, as the screen shows it: after the last LF, after the last
 *  carriage return that was followed by something, and without an unfinished escape. */
export function lastVisibleLine(tail: string): string {
  let line = tail.slice(tail.lastIndexOf('\n') + 1)
  const esc = line.indexOf('\x1b')
  if (esc !== -1) line = line.slice(0, esc)
  const parts = line.split('\r')
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].trim() !== '') return parts[i]
  return ''
}

// Each is the whole line, start to end, so "New password:", "Retype new password:" and
// "(current) UNIX password:" (passwd asking for a password the button has no business
// typing) are not prompts here.
const PROMPTS: { re: RegExp; kind: SecretPromptKind; ambiguous: boolean }[] = [
  { re: /^\[sudo\] (?:password for|palavra-passe para|senha para) [^\s:]+:\s*$/i, kind: 'sudo', ambiguous: false },
  { re: /^Enter passphrase for (?:key )?'[^']+':\s*$/i, kind: 'passphrase', ambiguous: false },
  { re: /^([^\s@']+)@([^\s@']+)'s password:\s*$/i, kind: 'login', ambiguous: false },
  { re: /^(?:password|palavra-passe|senha):\s*$/i, kind: 'sudo', ambiguous: true }
]

/** The host a shell belongs to, as far as a `user@host's password:` prompt is concerned. */
export interface PromptSelf {
  username: string
  host: string
}

/** `[::1]` and `[host]:2222` as ssh prints them, reduced to the bare host. */
function bareHost(h: string): string {
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(h)
  return (m ? m[1] : h).toLowerCase()
}

/**
 * The password prompt the tail ends on, or null when its last visible line is anything else.
 * A `user@host's password:` prompt only counts when it names `self` (same user and host, case
 * ignored): one from an `ssh` to another machine inside this session must not be offered this
 * host's login password, so it is not a prompt here at all. Without `self` it never counts.
 */
export function matchSecretPrompt(tail: string, self?: PromptSelf): SecretPromptMatch | null {
  const line = lastVisibleLine(tail).trim()
  if (!line.endsWith(':')) return null
  for (const p of PROMPTS) {
    const m = p.re.exec(line)
    if (!m) continue
    if (p.kind === 'login') {
      if (!self) return null
      if (m[1].toLowerCase() !== self.username.toLowerCase() || bareHost(m[2]) !== bareHost(self.host)) return null
    }
    return { kind: p.kind, ambiguous: p.ambiguous }
  }
  return null
}

export function detectSecretPrompt(tail: string, self?: PromptSelf): SecretPromptKind | null {
  return matchSecretPrompt(tail, self)?.kind ?? null
}

/** The parts of a saved host the choice reads. Secrets included: this runs in main only. */
export interface SecretSource {
  authType: SshAuthType
  elevation?: unknown
  password?: string
  passphrase?: string
  elevationPassword?: string
}

/** The secret sudo or su should get: the login password in `login` mode, the separate one in
 *  `other` mode, nothing in `none`. */
export function elevationSecret(h: SecretSource): string | undefined {
  const mode = effectiveElevation(h)
  const v = mode === 'login' ? h.password : mode === 'other' ? h.elevationPassword : undefined
  return v || undefined
}

/** The secret a prompt asks for, or undefined when the host has none for it. An explicit
 *  `[sudo]` prompt takes the elevation secret only; a bare `Password:` falls back to the login
 *  password when there is no elevation secret. */
export function secretForPrompt(match: SecretPromptMatch, h: SecretSource): string | undefined {
  if (match.kind === 'passphrase') return h.passphrase || undefined
  if (match.kind === 'login') return h.password || undefined
  const elev = elevationSecret(h)
  if (elev) return elev
  return match.ambiguous ? h.password || undefined : undefined
}

/** What a forced send (no prompt seen, the user confirmed) types: the elevation secret, else
 *  the login password. */
export function secretForForcedSend(h: SecretSource): string | undefined {
  return elevationSecret(h) ?? (h.password || undefined)
}

/** True when terminal input is only xterm's focus in/out reports (`ESC [ I`, `ESC [ O`),
 *  which the refocus after an Elevate click produces when the remote side asked for them.
 *  Anything else (keys, a paste) is the user taking over the shell. */
export function isOnlyFocusReports(data: string): boolean {
  return /^(?:\x1b\[[IO])+$/.test(data)
}

export const SEND_MIN_INTERVAL_MS = 1000
export const FORCE_WINDOW_MS = 15_000

/**
 * Per-shell bookkeeping for the send-secret handler:
 *  - at most one secret written per shell per `minIntervalMs` (only actual writes count, so a
 *    quick "Send anyway" after a no-prompt answer is not refused);
 *  - a forced send is only accepted within `forceWindowMs` of a plain send that was answered
 *    `no-prompt` for the same shell, and only once, so a renderer cannot skip the guard by
 *    asking for force straight away or by repeating it.
 */
export class SecretSendGuard {
  private readonly lastSend = new Map<string, number>()
  private readonly noPromptAt = new Map<string, number>()

  constructor(
    private readonly minIntervalMs: number = SEND_MIN_INTERVAL_MS,
    private readonly forceWindowMs: number = FORCE_WINDOW_MS
  ) {}

  rateLimited(id: string, now: number): boolean {
    const last = this.lastSend.get(id)
    return last !== undefined && now - last < this.minIntervalMs
  }

  /** A plain (not forced) send found no prompt: opens the force window. */
  noteNoPrompt(id: string, now: number): void {
    this.noPromptAt.set(id, now)
  }

  canForce(id: string, now: number): boolean {
    const at = this.noPromptAt.get(id)
    return at !== undefined && now - at >= 0 && now - at <= this.forceWindowMs
  }

  /** A secret was written: starts the rate limit and uses up any open force window. */
  noteSent(id: string, now: number): void {
    this.lastSend.set(id, now)
    this.noPromptAt.delete(id)
  }

  forget(id: string): void {
    this.lastSend.delete(id)
    this.noPromptAt.delete(id)
  }
}
