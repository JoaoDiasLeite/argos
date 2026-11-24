import type { SshAuthType } from './ssh-host-pure'

/**
 * Pure decisions behind asking for a secret when a Remote Session connects (sftp.ts
 * openSession) and behind answering ssh2's `keyboard-interactive` prompts (ssh.ts). No ssh2
 * here: the callers hand in plain prompt objects and parse errors.
 */

/** One keyboard-interactive prompt as ssh2 hands it over. */
export interface KbdPrompt {
  prompt: string
  echo?: boolean
}

// "Verification code", "Passcode", "One-time password": an OTP prompt, never the login
// password, even though "pass" or "password" may appear in it.
const NOT_LOGIN_PASSWORD_RE = /passcode|one[- ]?time|\botp\b|token|verification|c[óo]digo|code/i
const PASSWORD_RE = /pass(word)?|palavra-passe|senha/i

/** Whether a server prompt asks for the login password (and not an OTP or a PAM question). */
export function looksLikePasswordPrompt(text: string): boolean {
  return PASSWORD_RE.test(text) && !NOT_LOGIN_PASSWORD_RE.test(text)
}

export type KbdDecision =
  /** Answer with these; `auto` when it was the known password, typed by nobody. */
  | { kind: 'answer'; answers: string[]; auto: boolean }
  /** Ask the user, one prompt at a time. */
  | { kind: 'ask' }
  /** Answer nothing (an empty array), which fails this authentication method. */
  | { kind: 'fail' }

/**
 * How to answer one keyboard-interactive round. A lone, unechoed password prompt gets the
 * known password, but only once per connection attempt: a server that asks again has turned
 * it down, and replaying a wrong password only burns tries towards a lockout. Everything else
 * (an OTP, a PAM question, several prompts) goes to the user when someone is there to ask,
 * and fails otherwise.
 */
export function keyboardInteractiveDecision(
  prompts: readonly KbdPrompt[],
  ctx: { knownPassword?: string; autoAnswered: boolean; interactive: boolean }
): KbdDecision {
  // An info-only round (instructions, no questions) wants an empty answer to carry on.
  if (prompts.length === 0) return { kind: 'answer', answers: [], auto: false }
  if (
    prompts.length === 1 &&
    !prompts[0].echo &&
    looksLikePasswordPrompt(prompts[0].prompt) &&
    ctx.knownPassword &&
    !ctx.autoAnswered
  ) {
    return { kind: 'answer', answers: [ctx.knownPassword], auto: true }
  }
  return ctx.interactive ? { kind: 'ask' } : { kind: 'fail' }
}

/** ssh2's parse error for an encrypted private key opened without a passphrase (OpenSSH,
 *  old-style OpenSSH and PPK all say "…, but no passphrase given"). */
export function keyNeedsPassphrase(parseError: string | undefined): boolean {
  return !!parseError && /no passphrase given/i.test(parseError)
}

export type SecretToAsk = 'password' | 'passphrase'

/**
 * The secret to ask for before dialling, or null. A password host with no password (saved or
 * in memory) has nothing to log in with; a key host whose key will not parse without a
 * passphrase has nothing to sign with. `keyParseError` is what parsing the key without a
 * passphrase reported, when the caller tried.
 */
export function secretToAskBeforeConnect(
  h: { authType: SshAuthType; password?: string; passphrase?: string; privateKeyPath?: string },
  keyParseError?: string
): SecretToAsk | null {
  if (h.authType === 'password') return h.password ? null : 'password'
  if (h.authType === 'key' && h.privateKeyPath && !h.passphrase && keyNeedsPassphrase(keyParseError)) return 'passphrase'
  return null
}

/** Secrets typed at the connect prompt and kept in main memory for one pooled connection. */
export interface SessionSecrets {
  password?: string
  passphrase?: string
}

/**
 * `h` with the in-memory secrets filled in where nothing is saved. A saved secret always
 * wins, and each one only applies to the auth type it belongs to. The result carries secrets:
 * it is for main's own use (connecting, the terminal's Send password) and never goes to the
 * store, the renderer or the agent.
 */
export function withSessionSecrets<T extends { authType: SshAuthType; password?: string; passphrase?: string }>(
  h: T,
  mem: SessionSecrets | undefined
): T {
  if (!mem) return h
  const out = { ...h }
  if (h.authType === 'password' && !h.password && mem.password) out.password = mem.password
  if (h.authType === 'key' && !h.passphrase && mem.passphrase) out.passphrase = mem.passphrase
  return out
}

export const SERVER_PROMPT_MAX = 200

/**
 * A server-sent prompt, made safe to show: control characters (escapes included) become
 * spaces, runs of whitespace collapse, and the text is capped. It is still untrusted text and
 * is rendered as plain text only.
 */
export function sanitizeServerPrompt(text: unknown, max: number = SERVER_PROMPT_MAX): string {
  if (typeof text !== 'string') return ''
  // C0, DEL and C1: a terminal escape in a prompt must not reach the dialog as markup or noise.
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}
