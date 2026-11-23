import { describe, it, expect } from 'vitest'
import {
  appendTail,
  detectSecretPrompt,
  elevationSecret,
  isOnlyFocusReports,
  lastVisibleLine,
  matchSecretPrompt,
  secretForForcedSend,
  secretForPrompt,
  SecretSendGuard,
  stripAnsi,
  TAIL_MAX,
  type SecretSource
} from './secret-prompt-pure'

describe('stripAnsi', () => {
  it('removes colours, cursor moves and OSC titles', () => {
    expect(stripAnsi('\x1b[1;31mred\x1b[0m \x1b[2K\x1b[10;5Hx')).toBe('red x')
    expect(stripAnsi('\x1b]0;joao@web: ~\x07$ ')).toBe('$ ')
    expect(stripAnsi('\x1b]2;title\x1b\\ok')).toBe('ok')
  })

  it('removes two-character escapes and stray controls but keeps CR, LF and tab', () => {
    expect(stripAnsi('\x1b=\x1b>\x1b(B\x1b7a\x07b\x08c\r\n\td')).toBe('abc\r\n\td')
  })

  it('removes private mode CSI such as bracketed paste on and off', () => {
    expect(stripAnsi('\x1b[?2004hPassword: \x1b[?2004l')).toBe('Password: ')
  })

  it('leaves an unfinished CSI or OSC at the end alone', () => {
    expect(stripAnsi('abc\x1b[3')).toBe('abc\x1b[3')
    expect(stripAnsi('abc\x1b]0;tit')).toBe('abc\x1b]0;tit')
  })
})

describe('appendTail', () => {
  it('heals an escape sequence split across two chunks', () => {
    let tail = appendTail('', '[sudo] password for joao: \x1b[3')
    tail = appendTail(tail, '1m')
    expect(tail).toBe('[sudo] password for joao: ')
    expect(detectSecretPrompt(tail)).toBe('sudo')
  })

  it('keeps only the last max characters', () => {
    const tail = appendTail('', 'x'.repeat(1000) + '\r\nPassword: ', 50)
    expect(tail.length).toBe(50)
    expect(detectSecretPrompt(tail)).toBe('sudo')
  })

  it('only looks at the end of a large chunk', () => {
    const tail = appendTail('old', '\x1b[31m' + 'y'.repeat(100_000) + '\r\nSenha: ')
    expect(tail.length).toBe(TAIL_MAX)
    expect(tail.startsWith('old')).toBe(false)
    expect(detectSecretPrompt(tail)).toBe('sudo')
  })
})

describe('lastVisibleLine', () => {
  it('takes the text after the last LF and the last overwriting CR', () => {
    expect(lastVisibleLine('a\r\nb')).toBe('b')
    expect(lastVisibleLine('spinner\rPassword: ')).toBe('Password: ')
    expect(lastVisibleLine('Password: \r')).toBe('Password: ')
    expect(lastVisibleLine('Password:\r\n')).toBe('')
  })

  it('ignores an unfinished escape at the end', () => {
    expect(lastVisibleLine('Password: \x1b[')).toBe('Password: ')
  })
})

describe('detectSecretPrompt', () => {
  const positives: [string, string][] = [
    ['[sudo] password for joao: ', 'sudo'],
    ['[sudo] password for joao.leite:', 'sudo'],
    ['[sudo] palavra-passe para joao: ', 'sudo'],
    ['[SUDO] Password For root:', 'sudo'],
    ['Password: ', 'sudo'],
    ['password:', 'sudo'],
    ['Palavra-passe: ', 'sudo'],
    ['Senha:   ', 'sudo'],
    ["Enter passphrase for key '/home/joao/.ssh/id_ed25519': ", 'passphrase'],
    ["Enter passphrase for '/home/joao/.ssh/id_rsa':", 'passphrase']
  ]
  it.each(positives)('%j is a %s prompt', (text, kind) => {
    expect(detectSecretPrompt(`joao@web:~$ sudo -i\r\n${text}`)).toBe(kind)
  })

  const negatives = [
    'joao@web:~$ ',
    'New password: ',
    'Retype new password: ',
    '(current) UNIX password: ',
    'Current password: ',
    'Password for the database: ',
    'echo [sudo] password for joao: done',
    'Enter passphrase (empty for no passphrase): ',
    'Password',
    ''
  ]
  it.each(negatives)('%j is not a prompt', (text) => {
    expect(detectSecretPrompt(`x\r\n${text}`)).toBeNull()
  })

  describe("user@host's password: only for this host", () => {
    const self = { username: 'joao', host: 'Web01.example.pt' }
    it('matches the same user and host, case ignored', () => {
      expect(detectSecretPrompt("x\r\njoao@web01.example.pt's password: ", self)).toBe('login')
      expect(detectSecretPrompt("JOAO@WEB01.EXAMPLE.PT's password:", self)).toBe('login')
      expect(detectSecretPrompt("root@10.0.0.5's password:", { username: 'root', host: '10.0.0.5' })).toBe('login')
      expect(detectSecretPrompt("joao@[::1]'s password: ", { username: 'joao', host: '::1' })).toBe('login')
    })
    it('a nested ssh to another user or host is not a prompt', () => {
      expect(matchSecretPrompt("joao@db01.example.pt's password: ", self)).toBeNull()
      expect(matchSecretPrompt("root@web01.example.pt's password: ", self)).toBeNull()
      expect(matchSecretPrompt("joao@web01's password: ", self)).toBeNull()
    })
    it('without a host to compare with, it is not a prompt', () => {
      expect(matchSecretPrompt("joao@web01.example.pt's password: ")).toBeNull()
    })
    it('a bare Password: does not depend on the host', () => {
      expect(detectSecretPrompt('Password: ', self)).toBe('sudo')
    })
  })

  it('a prompt followed by a new line is no longer a prompt', () => {
    expect(detectSecretPrompt('[sudo] password for joao: \r\n')).toBeNull()
    expect(detectSecretPrompt('Password:\r\nSorry, try again.\r\n')).toBeNull()
    expect(detectSecretPrompt('Password: \r\n\x1b[?2004hroot@web:~# ')).toBeNull()
  })

  it('sees a prompt wrapped in escape sequences', () => {
    const raw = '\x1b[?2004l\r\x1b[1m[sudo] password for joao:\x1b[0m \x1b[K'
    expect(detectSecretPrompt(appendTail('', raw))).toBe('sudo')
  })

  it('handles CRLF line ends before the prompt', () => {
    expect(detectSecretPrompt(appendTail('', 'Last login: today\r\n\r\nsu -\r\nPalavra-passe: '))).toBe('sudo')
  })

  it('marks only the bare prompt as ambiguous', () => {
    expect(matchSecretPrompt('Password: ')).toEqual({ kind: 'sudo', ambiguous: true })
    expect(matchSecretPrompt('[sudo] password for joao: ')).toEqual({ kind: 'sudo', ambiguous: false })
  })
})

describe('secret choice', () => {
  const pw: SecretSource = { authType: 'password', password: 'login-pw' }
  const keyOther: SecretSource = { authType: 'key', passphrase: 'pp', elevation: 'other', elevationPassword: 'elev-pw' }
  const keyNone: SecretSource = { authType: 'key', passphrase: 'pp' }
  const pwOther: SecretSource = { authType: 'password', password: 'login-pw', elevation: 'other', elevationPassword: 'elev-pw' }
  const pwNone: SecretSource = { authType: 'password', password: 'login-pw', elevation: 'none' }

  it('elevationSecret follows the elevation mode', () => {
    expect(elevationSecret(pw)).toBe('login-pw')
    expect(elevationSecret(keyOther)).toBe('elev-pw')
    expect(elevationSecret(keyNone)).toBeUndefined()
    expect(elevationSecret(pwNone)).toBeUndefined()
    expect(elevationSecret({ authType: 'key', elevation: 'login', password: 'stale' })).toBeUndefined()
  })

  it('an explicit sudo prompt takes the elevation secret only', () => {
    const sudo = { kind: 'sudo', ambiguous: false } as const
    expect(secretForPrompt(sudo, pwOther)).toBe('elev-pw')
    expect(secretForPrompt(sudo, pw)).toBe('login-pw')
    expect(secretForPrompt(sudo, pwNone)).toBeUndefined()
    expect(secretForPrompt(sudo, keyNone)).toBeUndefined()
  })

  it('a bare Password: falls back to the login password', () => {
    const plain = { kind: 'sudo', ambiguous: true } as const
    expect(secretForPrompt(plain, pwOther)).toBe('elev-pw')
    expect(secretForPrompt(plain, pwNone)).toBe('login-pw')
    expect(secretForPrompt(plain, keyNone)).toBeUndefined()
  })

  it('login and passphrase prompts take their own secret', () => {
    expect(secretForPrompt({ kind: 'login', ambiguous: false }, pwOther)).toBe('login-pw')
    expect(secretForPrompt({ kind: 'login', ambiguous: false }, keyOther)).toBeUndefined()
    expect(secretForPrompt({ kind: 'passphrase', ambiguous: false }, keyOther)).toBe('pp')
    expect(secretForPrompt({ kind: 'passphrase', ambiguous: false }, pw)).toBeUndefined()
  })

  it('a forced send takes the elevation secret, else the login password', () => {
    expect(secretForForcedSend(pwOther)).toBe('elev-pw')
    expect(secretForForcedSend(pwNone)).toBe('login-pw')
    expect(secretForForcedSend(keyOther)).toBe('elev-pw')
    expect(secretForForcedSend(keyNone)).toBeUndefined()
  })
})

describe('SecretSendGuard', () => {
  it('allows one write per second per shell', () => {
    const g = new SecretSendGuard()
    expect(g.rateLimited('a', 0)).toBe(false)
    g.noteSent('a', 0)
    expect(g.rateLimited('a', 999)).toBe(true)
    expect(g.rateLimited('b', 999)).toBe(false)
    expect(g.rateLimited('a', 1000)).toBe(false)
  })

  it('does not count a no-prompt answer as a write', () => {
    const g = new SecretSendGuard()
    g.noteNoPrompt('a', 0)
    expect(g.rateLimited('a', 10)).toBe(false)
    expect(g.canForce('a', 10)).toBe(true)
  })

  it('accepts force only within 15 s of a no-prompt for the same shell', () => {
    const g = new SecretSendGuard()
    expect(g.canForce('a', 0)).toBe(false)
    g.noteNoPrompt('a', 1000)
    expect(g.canForce('b', 1000)).toBe(false)
    expect(g.canForce('a', 16_000)).toBe(true)
    expect(g.canForce('a', 16_001)).toBe(false)
  })

  it('uses the force window up once a secret is written', () => {
    const g = new SecretSendGuard()
    g.noteNoPrompt('a', 0)
    g.noteSent('a', 100)
    expect(g.canForce('a', 200)).toBe(false)
  })

  it('forgets a shell', () => {
    const g = new SecretSendGuard()
    g.noteNoPrompt('a', 0)
    g.noteSent('a', 0)
    g.noteNoPrompt('a', 0)
    g.forget('a')
    expect(g.rateLimited('a', 1)).toBe(false)
    expect(g.canForce('a', 1)).toBe(false)
  })
})

describe('isOnlyFocusReports', () => {
  it('matches focus in and out reports only', () => {
    expect(isOnlyFocusReports('[I')).toBe(true)
    expect(isOnlyFocusReports('[O[I')).toBe(true)
    expect(isOnlyFocusReports('')).toBe(false)
    expect(isOnlyFocusReports('[A')).toBe(false)
    expect(isOnlyFocusReports('')).toBe(false)
    expect(isOnlyFocusReports('[200~pw[201~')).toBe(false)
    expect(isOnlyFocusReports('[Ia')).toBe(false)
  })
})
