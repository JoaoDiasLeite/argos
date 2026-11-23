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
  /** For a passphrase prompt, the key file as ssh printed it (cut to 100 characters). */
  keyPath?: string
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
// typing) are not prompts here. The two `login` forms name a user and a host (groups 1 and
// 2): `user@host's password:` is OpenSSH's password prompt, `(user@host) Password:` its
// keyboard-interactive one (the client puts them in front of the server's own prompt text).
const PROMPTS: { re: RegExp; kind: SecretPromptKind; ambiguous: boolean }[] = [
  { re: /^\[sudo\] (?:password for|palavra-passe para|senha para) [^\s:]+:\s*$/i, kind: 'sudo', ambiguous: false },
  { re: /^Enter passphrase for (?:key )?'([^']+)':\s*$/i, kind: 'passphrase', ambiguous: false },
  { re: /^([^\s@']+)@([^\s@']+)'s password:\s*$/i, kind: 'login', ambiguous: false },
  { re: /^\(([^\s@'()]+)@([^\s@'()]+)\) (?:password|palavra-passe|senha):\s*$/i, kind: 'login', ambiguous: false },
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
    if (p.kind === 'passphrase') return { kind: p.kind, ambiguous: p.ambiguous, keyPath: m[1] }
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

/** Whether a send-secret call's options ask for a forced send. Shape-checked: they come over
 *  IPC. */
export function wantsForce(opts: unknown): boolean {
  return opts !== null && typeof opts === 'object' && (opts as { force?: unknown }).force === true
}

/** A saved host as the send decision reads it: its secrets, and its user and address for the
 *  `user@host's password:` check. */
export type SendSecretHost = SecretSource & PromptSelf

export type SecretSendDecision =
  /** Write exactly this to the terminal (the secret, with Enter when a prompt was seen). */
  | { write: string }
  | { reason: 'no-secret' | 'no-prompt' | 'rate-limited' }

/**
 * The "Send password" decision, shared by the Remote Session shells (remote-shell.ts) and the
 * remote chats' ssh terminals (terminal.ts) so both apply the same guard:
 *  - one write per terminal per second;
 *  - a prompt on the last line gets the secret it asks for, followed by Enter;
 *  - no prompt: refuse with `no-prompt` and open the force window;
 *  - a forced send only inside that window, typing the elevation or login password WITHOUT
 *    Enter so a mistake can be erased with Ctrl+U.
 * The caller writes `write` and then calls `guard.noteSent`; nothing here touches a terminal.
 */
export function decideSecretSend(
  guard: SecretSendGuard,
  id: string,
  tail: string,
  host: SendSecretHost | null,
  force: boolean,
  now: number
): SecretSendDecision {
  if (guard.rateLimited(id, now)) return { reason: 'rate-limited' }
  if (!host) return { reason: 'no-secret' }
  // A nested ssh's `user@host's password:` that is not this host is no prompt, so it answers
  // no-prompt and only a confirmed forced send can type into it.
  const match = matchSecretPrompt(tail, { username: host.username, host: host.host })
  if (match) {
    const secret = secretForPrompt(match, host)
    return secret ? { write: secret + '\r' } : { reason: 'no-secret' }
  }
  if (!force) {
    guard.noteNoPrompt(id, now)
    return { reason: 'no-prompt' }
  }
  // A force that did not follow a no-prompt answer is refused without opening a window of
  // its own, so two forced calls in a row cannot skip the guard.
  if (!guard.canForce(id, now)) return { reason: 'no-prompt' }
  const secret = secretForForcedSend(host)
  return secret ? { write: secret } : { reason: 'no-secret' }
}

// ─── The remote chats' ssh login ────────────────────────────────────────────

/** How long after the ssh terminal is spawned its login prompt may be answered on its own. */
export const LOGIN_WINDOW_MS = 30_000

export type LoginSecretKind = 'login' | 'passphrase'

/** Windows paths compare without regard to case or slash direction. */
function normalisePath(p: string): string {
  return p.replace(/\//g, '\\').toLowerCase()
}

/** Whether a passphrase prompt names this key. ssh prints at most the first 100 bytes of the
 *  path, so the printed one only has to begin the expected one; a cut through a multi-byte
 *  character (an accented user name) leaves a replacement character at the end, dropped here. */
function sameKeyFile(shown: string | undefined, expected: string): boolean {
  if (!shown) return false
  const s = normalisePath(shown.replace(/�+$/, ''))
  return s.length > 0 && normalisePath(expected).startsWith(s)
}

/**
 * Which saved secret ssh's own login prompt on the tail's last line asks for, or null when it
 * is not such a prompt or the host has nothing for it. Deliberately not secretForPrompt: at
 * login a bare `Password:` (keyboard-interactive on an older client, or a PAM prompt) is the
 * login password, never the elevation one, and a `[sudo]` prompt is never answered at all.
 *  - `user@host's password:` and `(user@host) Password:` count only for this host's user;
 *  - the login password only on a password host, the passphrase only on a key host and only
 *    for the key file the host names (`keyPath`, `~` already expanded by the caller).
 */
export function loginPromptSecret(
  tail: string,
  host: { authType: SshAuthType; username: string; host: string; password?: string; passphrase?: string },
  keyPath?: string
): { kind: LoginSecretKind; secret: string } | null {
  const match = matchSecretPrompt(tail, { username: host.username, host: host.host })
  if (!match) return null
  const login = match.kind === 'login' || (match.kind === 'sudo' && match.ambiguous)
  if (login) {
    return host.authType === 'password' && host.password ? { kind: 'login', secret: host.password } : null
  }
  if (match.kind === 'passphrase') {
    if (host.authType !== 'key' || !host.passphrase || !keyPath || !sameKeyFile(match.keyPath, keyPath)) return null
    return { kind: 'passphrase', secret: host.passphrase }
  }
  return null
}

/**
 * The one automatic answer an ssh chat terminal gets: armed when the pty is spawned, it lets
 * the caller answer ssh's login prompt once, inside the first LOGIN_WINDOW_MS. The answer is
 * acceptable here because ssh has already checked the server's key against Argos' trusted
 * list before it asks, and the secret is that server's own. After the answer it is spent: a
 * second prompt means the secret was wrong, and replaying it only burns tries, so it is the
 * user's turn. Anything the user types also ends it.
 */
export class LoginAutoAnswer {
  private spent = false

  constructor(
    private readonly startedAt: number,
    private readonly windowMs: number = LOGIN_WINDOW_MS
  ) {}

  /** Whether an answer may still be given at `now`. */
  armed(now: number): boolean {
    if (this.spent) return false
    if (now - this.startedAt > this.windowMs || now < this.startedAt) this.spent = true
    return !this.spent
  }

  /**
   * Called with the terminal's tail after each chunk of output. `pick` reads the prompt and
   * the secret (loginPromptSecret, given the host); it runs only while armed, so the store is
   * not read for every chunk of a long session. Returns what to write, once.
   */
  answer<T extends { secret: string }>(now: number, pick: () => T | null): T | null {
    if (!this.armed(now)) return null
    const found = pick()
    if (!found) return null
    this.spent = true
    return found
  }

  /** The user typed, or the terminal is going away. */
  disarm(): void {
    this.spent = true
  }
}

/** What wrote to a held ssh terminal: the CLI launch line Argos types, a key the user
 *  pressed, or xterm answering a query (focus, cursor position). */
export type HeldWriteSource = 'launch' | 'user' | 'report'

// ssh's own words for a refused login. Seen before the next prompt (or before ssh gives up),
// they are not the shell starting.
const AUTH_FAILED_RE = /permission denied|please try again|authentication failed|too many authentication failures|connection closed|connection reset/i

// Bracketed paste switched on: what bash and zsh print as their prompt appears, so the remote
// shell is up even when no answer was needed (a key the agent held, say).
const SHELL_READY_RE = /\x1b\[\?2004h/

/**
 * Holds what the renderer writes to an ssh chat terminal while its login is still being
 * answered, so the CLI launch line (typed about 600 ms after spawn) can never be read by ssh
 * as a password, and is not lost: Windows ssh drops anything typed before it asks, and takes
 * anything typed while it asks as the answer. Used only when the login answer is armed.
 *
 * Phases:
 *  - `waiting`: no answer yet. Everything is queued.
 *  - `answered`: the saved secret went in. Everything is queued until the shell shows.
 *  - `user`: a prompt the auto-answer did not take (a refused secret asked again, or the user
 *    typed first). The user's keys pass straight through, since they are the password; keys
 *    queued earlier are dropped rather than typed into that prompt; the launch line stays
 *    queued until the shell shows.
 *  - `open`: the shell is up, or the hold timed out away from a prompt. Everything passes, and
 *    the queue is flushed once, in order.
 * Answers to terminal queries are dropped while held: they answer a screen that is gone.
 */
export class LoginHold {
  private phase: 'waiting' | 'answered' | 'user' | 'open' = 'waiting'
  private queue: { data: string; source: HeldWriteSource }[] = []

  get open(): boolean {
    return this.phase === 'open'
  }

  /** A write from the renderer or the launch. True when it may go to the pty now. */
  write(data: string, source: HeldWriteSource): boolean {
    if (this.phase === 'open') return true
    if (this.phase === 'user' && source !== 'launch') return true
    if (source !== 'report') this.queue.push({ data, source })
    return false
  }

  /** The auto-answer just wrote the secret. */
  answered(): void {
    if (this.phase === 'waiting') this.phase = 'answered'
  }

  /**
   * Output arrived. `raw` is the chunk as received, `atPrompt` whether the tail's last line is
   * a password prompt after the auto-answer had its chance at it. Returns what to write now
   * (the flushed queue), or null.
   */
  output(raw: string, atPrompt: boolean): string[] | null {
    if (this.phase === 'open') return null
    if (atPrompt) {
      // A prompt still showing after the auto-answer looked at it is the user's to answer.
      if (this.phase !== 'user') this.toUser()
      return null
    }
    const text = stripAnsi(raw).trim()
    const shellStarted =
      SHELL_READY_RE.test(raw) || (this.phase !== 'waiting' && text !== '' && !AUTH_FAILED_RE.test(text))
    return shellStarted ? this.release() : null
  }

  /** The login window ran out. Away from a prompt the queue goes out; at one, it waits for the
   *  shell like a refused answer does. */
  expire(atPrompt: boolean): string[] | null {
    if (this.phase === 'open') return null
    if (atPrompt) {
      if (this.phase !== 'user') this.toUser()
      return null
    }
    return this.release()
  }

  private toUser(): void {
    this.phase = 'user'
    this.queue = this.queue.filter((w) => w.source === 'launch')
  }

  private release(): string[] {
    this.phase = 'open'
    const out = this.queue.map((w) => w.data)
    this.queue = []
    return out
  }
}
