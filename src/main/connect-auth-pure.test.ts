import { describe, expect, it } from 'vitest'
import {
  keyboardInteractiveDecision,
  keyNeedsPassphrase,
  looksLikePasswordPrompt,
  sanitizeServerPrompt,
  secretToAskBeforeConnect,
  withSessionSecrets
} from './connect-auth-pure'
import { elevationSecret, secretForForcedSend, secretForPrompt } from './secret-prompt-pure'

describe('looksLikePasswordPrompt', () => {
  it('matches login password prompts in English and Portuguese', () => {
    for (const p of ['Password: ', 'password:', 'joao@srv password:', 'Palavra-passe:', 'Senha:', 'Pass:']) {
      expect(looksLikePasswordPrompt(p)).toBe(true)
    }
  })
  it('does not take an OTP or a PAM question for the password', () => {
    for (const p of ['Verification code: ', 'Passcode or option (1-3): ', 'One-time password:', 'OTP:', 'Token:', 'Código:', 'Your mother maiden name?']) {
      expect(looksLikePasswordPrompt(p)).toBe(false)
    }
  })
})

describe('keyboardInteractiveDecision', () => {
  const pw = [{ prompt: 'Password: ', echo: false }]

  it('answers a lone unechoed password prompt with the known password', () => {
    expect(keyboardInteractiveDecision(pw, { knownPassword: 's3cret', autoAnswered: false, interactive: false })).toEqual({
      kind: 'answer',
      answers: ['s3cret'],
      auto: true
    })
  })

  it('does not replay the known password once the server asked again', () => {
    expect(keyboardInteractiveDecision(pw, { knownPassword: 's3cret', autoAnswered: true, interactive: true })).toEqual({ kind: 'ask' })
    expect(keyboardInteractiveDecision(pw, { knownPassword: 's3cret', autoAnswered: true, interactive: false })).toEqual({ kind: 'fail' })
  })

  it('asks for a password prompt with no known password only when interactive', () => {
    expect(keyboardInteractiveDecision(pw, { autoAnswered: false, interactive: true })).toEqual({ kind: 'ask' })
    expect(keyboardInteractiveDecision(pw, { autoAnswered: false, interactive: false })).toEqual({ kind: 'fail' })
  })

  it('never answers an echoed or OTP prompt with the password', () => {
    const echoed = [{ prompt: 'Password: ', echo: true }]
    const otp = [{ prompt: 'Verification code: ', echo: false }]
    for (const prompts of [echoed, otp]) {
      expect(keyboardInteractiveDecision(prompts, { knownPassword: 'x', autoAnswered: false, interactive: true })).toEqual({ kind: 'ask' })
      expect(keyboardInteractiveDecision(prompts, { knownPassword: 'x', autoAnswered: false, interactive: false })).toEqual({ kind: 'fail' })
    }
  })

  it('sends several prompts to the user', () => {
    const two = [
      { prompt: 'Password: ', echo: false },
      { prompt: 'Verification code: ', echo: false }
    ]
    expect(keyboardInteractiveDecision(two, { knownPassword: 'x', autoAnswered: false, interactive: true })).toEqual({ kind: 'ask' })
  })

  it('answers an info-only round with nothing', () => {
    expect(keyboardInteractiveDecision([], { autoAnswered: false, interactive: false })).toEqual({ kind: 'answer', answers: [], auto: false })
  })
})

describe('secretToAskBeforeConnect', () => {
  const noPass = 'Encrypted private OpenSSH key detected, but no passphrase given'

  it('asks for the password of a password host without one', () => {
    expect(secretToAskBeforeConnect({ authType: 'password' })).toBe('password')
    expect(secretToAskBeforeConnect({ authType: 'password', password: '' })).toBe('password')
    expect(secretToAskBeforeConnect({ authType: 'password', password: 'x' })).toBeNull()
  })

  it('asks for the passphrase of an encrypted key only when the parse said so', () => {
    const key = { authType: 'key' as const, privateKeyPath: 'C:\\k' }
    expect(secretToAskBeforeConnect(key, noPass)).toBe('passphrase')
    expect(secretToAskBeforeConnect(key, 'Encrypted PPK private key detected, but no passphrase given')).toBe('passphrase')
    expect(secretToAskBeforeConnect(key)).toBeNull()
    expect(secretToAskBeforeConnect(key, 'Unsupported key format')).toBeNull()
    expect(secretToAskBeforeConnect({ ...key, passphrase: 'p' }, noPass)).toBeNull()
    expect(secretToAskBeforeConnect({ authType: 'key' }, noPass)).toBeNull()
  })

  it('never asks for an agent host', () => {
    expect(secretToAskBeforeConnect({ authType: 'agent' }, noPass)).toBeNull()
  })

  it('reads the parse error', () => {
    expect(keyNeedsPassphrase(noPass)).toBe(true)
    expect(keyNeedsPassphrase('bad passphrase?')).toBe(false)
    expect(keyNeedsPassphrase(undefined)).toBe(false)
  })
})

describe('withSessionSecrets', () => {
  type H = { authType: 'password' | 'key' | 'agent'; password?: string; passphrase?: string }
  it('fills a missing password or passphrase from memory', () => {
    expect(withSessionSecrets<H>({ authType: 'password' }, { password: 'm' }).password).toBe('m')
    expect(withSessionSecrets<H>({ authType: 'key' }, { passphrase: 'm' }).passphrase).toBe('m')
  })

  it('keeps a saved secret over the one in memory', () => {
    expect(withSessionSecrets({ authType: 'password' as const, password: 'saved' }, { password: 'm' }).password).toBe('saved')
  })

  it('applies each secret only to its own auth type', () => {
    const agent = withSessionSecrets<H>({ authType: 'agent' }, { password: 'm', passphrase: 'p' })
    expect(agent.password).toBeUndefined()
    expect(agent.passphrase).toBeUndefined()
  })

  it('leaves the input alone', () => {
    const h = { authType: 'password' as const }
    withSessionSecrets(h, { password: 'm' })
    expect(h).toEqual({ authType: 'password' })
    expect(withSessionSecrets(h, undefined)).toBe(h)
  })
})

describe('sanitizeServerPrompt', () => {
  it('strips escapes and control characters and collapses whitespace', () => {
    expect(sanitizeServerPrompt('\x1b[31mPass\x07word:\r\n  ')).toBe('[31mPass word:')
  })
  it('caps the length', () => {
    const s = sanitizeServerPrompt('a'.repeat(500), 20)
    expect(s.length).toBe(20)
    expect(s.endsWith('…')).toBe(true)
  })
  it('turns a non-string into empty text', () => {
    expect(sanitizeServerPrompt(undefined)).toBe('')
  })
})

describe('in-memory password through the terminal secret helpers', () => {
  // The Remote Session terminal's Send password / Elevate read the host through
  // withSessionSecrets (sftp.ts getHostWithSessionSecrets); these pin what they then pick.
  const sudo = { kind: 'sudo' as const, ambiguous: false }
  const bare = { kind: 'sudo' as const, ambiguous: true }
  const login = { kind: 'login' as const, ambiguous: false }

  it('uses the typed password as the login and elevation secret of a password host', () => {
    const h = withSessionSecrets({ authType: 'password' as const, password: undefined as string | undefined }, { password: 'typed' })
    expect(elevationSecret(h)).toBe('typed')
    expect(secretForPrompt(sudo, h)).toBe('typed')
    expect(secretForPrompt(bare, h)).toBe('typed')
    expect(secretForPrompt(login, h)).toBe('typed')
    expect(secretForForcedSend(h)).toBe('typed')
  })

  it('keeps the saved password over the typed one', () => {
    const h = withSessionSecrets({ authType: 'password' as const, password: 'saved' as string | undefined }, { password: 'typed' })
    expect(elevationSecret(h)).toBe('saved')
    expect(secretForForcedSend(h)).toBe('saved')
  })

  it('has nothing to send for a password host with neither', () => {
    const h = withSessionSecrets({ authType: 'password' as const, password: undefined as string | undefined }, undefined)
    expect(elevationSecret(h)).toBeUndefined()
    expect(secretForForcedSend(h)).toBeUndefined()
  })

  it('does not hand a typed password to a key host as its elevation secret', () => {
    const h = withSessionSecrets({ authType: 'key' as const, password: undefined as string | undefined }, { password: 'typed' })
    expect(elevationSecret(h)).toBeUndefined()
  })
})
