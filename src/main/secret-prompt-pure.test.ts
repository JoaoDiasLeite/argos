import { describe, it, expect } from 'vitest'
import {
  appendTail,
  decideSecretSend,
  detectSecretPrompt,
  elevationSecret,
  isOnlyFocusReports,
  lastVisibleLine,
  LOGIN_WINDOW_MS,
  LoginAutoAnswer,
  LoginChain,
  LoginHold,
  type LoginHostSecrets,
  type LoginStep,
  loginPromptSecret,
  matchSecretPrompt,
  secretForForcedSend,
  secretForPrompt,
  SecretSendGuard,
  stripAnsi,
  TAIL_MAX,
  wantsForce,
  type SecretSource,
  type SendSecretHost
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

describe('OpenSSH prompts as the Windows client prints them', () => {
  const self = { username: 'demo', host: '127.0.0.1' }

  it('reads the keyboard-interactive form for this host only', () => {
    expect(matchSecretPrompt('(demo@127.0.0.1) Password: ', self)).toEqual({ kind: 'login', ambiguous: false })
    expect(matchSecretPrompt('(root@127.0.0.1) Password: ', self)).toBeNull()
    expect(matchSecretPrompt('(demo@127.0.0.1) Password: ')).toBeNull()
    expect(matchSecretPrompt('(demo@127.0.0.1) Verification code: ', self)).toBeNull()
  })

  it('keeps the key file a passphrase prompt names', () => {
    expect(matchSecretPrompt("Enter passphrase for key 'C:\\Users\\demo\\.ssh\\id_ed25519': ")).toEqual({
      kind: 'passphrase',
      ambiguous: false,
      keyPath: 'C:\\Users\\demo\\.ssh\\id_ed25519'
    })
  })
})

describe('decideSecretSend', () => {
  const host: SendSecretHost = { authType: 'password', password: 'fake-login', username: 'joao', host: 'web01' }

  it('answers a prompt with its secret and Enter', () => {
    const g = new SecretSendGuard()
    expect(decideSecretSend(g, 't', '[sudo] password for joao: ', host, false, 0)).toEqual({ write: 'fake-login\r' })
  })

  it('refuses without a prompt, then allows one forced send without Enter', () => {
    const g = new SecretSendGuard()
    expect(decideSecretSend(g, 't', 'joao@web01:~$ ', host, true, 0)).toEqual({ reason: 'no-prompt' })
    expect(decideSecretSend(g, 't', 'joao@web01:~$ ', host, false, 10)).toEqual({ reason: 'no-prompt' })
    expect(decideSecretSend(g, 't', 'joao@web01:~$ ', host, true, 20)).toEqual({ write: 'fake-login' })
  })

  it('checks the rate limit first and needs a host', () => {
    const g = new SecretSendGuard()
    g.noteSent('t', 0)
    expect(decideSecretSend(g, 't', 'Password: ', host, false, 500)).toEqual({ reason: 'rate-limited' })
    expect(decideSecretSend(g, 'u', 'Password: ', null, false, 500)).toEqual({ reason: 'no-secret' })
  })

  it('does not take a nested ssh prompt for this host', () => {
    const g = new SecretSendGuard()
    expect(decideSecretSend(g, 't', "joao@db01's password: ", host, false, 0)).toEqual({ reason: 'no-prompt' })
  })

  it('reads force only from a real flag', () => {
    expect(wantsForce({ force: true })).toBe(true)
    expect(wantsForce({ force: 'yes' })).toBe(false)
    expect(wantsForce(null)).toBe(false)
    expect(wantsForce(true)).toBe(false)
  })
})

describe('loginPromptSecret', () => {
  const pwHost = { authType: 'password' as const, username: 'demo', host: '127.0.0.1', password: 'fake-login' }
  const keyPath = 'C:\\Users\\demo\\.ssh\\id_ed25519'
  const keyHost = { authType: 'key' as const, username: 'demo', host: '127.0.0.1', passphrase: 'fake-passphrase' }

  it("answers ssh's password prompts with the login password", () => {
    expect(loginPromptSecret("demo@127.0.0.1's password: ", pwHost)).toEqual({ kind: 'login', secret: 'fake-login' })
    expect(loginPromptSecret('(demo@127.0.0.1) Password: ', pwHost)).toEqual({ kind: 'login', secret: 'fake-login' })
    // An older client's keyboard-interactive prompt: the login password, never the elevation one.
    const withElevation = { ...pwHost, elevation: 'other', elevationPassword: 'fake-elev' }
    expect(loginPromptSecret('Password: ', withElevation)).toEqual({ kind: 'login', secret: 'fake-login' })
  })

  it('never answers sudo, another host, or a host with no such secret', () => {
    expect(loginPromptSecret('[sudo] password for demo: ', pwHost)).toBeNull()
    expect(loginPromptSecret("root@127.0.0.1's password: ", pwHost)).toBeNull()
    expect(loginPromptSecret("demo@127.0.0.1's password: ", { ...pwHost, password: undefined })).toBeNull()
    expect(loginPromptSecret("demo@127.0.0.1's password: ", { ...keyHost, password: 'stale' })).toBeNull()
    expect(loginPromptSecret('demo@127.0.0.1:~$ ', pwHost)).toBeNull()
  })

  it('answers the passphrase prompt for the host key only', () => {
    const prompt = `Enter passphrase for key '${keyPath}': `
    expect(loginPromptSecret(prompt, keyHost, keyPath)).toEqual({ kind: 'passphrase', secret: 'fake-passphrase' })
    expect(loginPromptSecret(prompt, keyHost, 'c:/users/demo/.ssh/id_ed25519')).toEqual({
      kind: 'passphrase',
      secret: 'fake-passphrase'
    })
    expect(loginPromptSecret("Enter passphrase for key 'C:\\Users\\demo\\.ssh\\other': ", keyHost, keyPath)).toBeNull()
    expect(loginPromptSecret(prompt, keyHost)).toBeNull()
    expect(loginPromptSecret(prompt, { ...pwHost, passphrase: 'x' }, keyPath)).toBeNull()
  })

  it('accepts the path ssh cut to 100 characters', () => {
    const long = 'C:\\Users\\demo\\' + 'a'.repeat(120) + '\\id_ed25519'
    const prompt = `Enter passphrase for key '${long.slice(0, 100)}': `
    expect(loginPromptSecret(prompt, keyHost, long)).toEqual({ kind: 'passphrase', secret: 'fake-passphrase' })
    // Cut through a two-byte character: the decoder leaves U+FFFD where the half was.
    const accented = 'C:\\Users\\João\\' + 'b'.repeat(120)
    const cut = `Enter passphrase for key '${accented.slice(0, 11)}\uFFFD': `
    expect(loginPromptSecret(cut, keyHost, accented)).toEqual({ kind: 'passphrase', secret: 'fake-passphrase' })
  })

  it('only looks at the last line', () => {
    expect(loginPromptSecret("demo@127.0.0.1's password: \r\nWelcome\r\n", pwHost)).toBeNull()
  })
})

describe('LoginAutoAnswer', () => {
  const pwHost = { authType: 'password' as const, username: 'demo', host: '127.0.0.1', password: 'fake-login' }
  const pick = (tail: string) => () => loginPromptSecret(tail, pwHost)

  it('answers the login prompt once', () => {
    const a = new LoginAutoAnswer(0)
    expect(a.answer(100, pick('Warning: Permanently added ...\r\n'))).toBeNull()
    expect(a.armed(100)).toBe(true)
    expect(a.answer(160, pick("demo@127.0.0.1's password: "))).toEqual({ kind: 'login', secret: 'fake-login' })
    expect(a.armed(161)).toBe(false)
  })

  it('does not answer a second prompt after a wrong password', () => {
    const a = new LoginAutoAnswer(0)
    expect(a.answer(160, pick("demo@127.0.0.1's password: "))).not.toBeNull()
    const again = "\r\nPermission denied, please try again.\r\ndemo@127.0.0.1's password: "
    expect(a.answer(400, pick(again))).toBeNull()
  })

  it('disarms after the window', () => {
    const a = new LoginAutoAnswer(1000)
    expect(a.armed(1000 + LOGIN_WINDOW_MS)).toBe(true)
    expect(a.answer(1001 + LOGIN_WINDOW_MS, pick("demo@127.0.0.1's password: "))).toBeNull()
    expect(a.armed(1000)).toBe(false)
  })

  it('only answers known kinds, and stays armed for the real prompt', () => {
    const a = new LoginAutoAnswer(0)
    expect(a.answer(10, pick('[sudo] password for demo: '))).toBeNull()
    expect(a.answer(20, pick('New password: '))).toBeNull()
    expect(a.answer(30, pick('(demo@127.0.0.1) Verification code: '))).toBeNull()
    expect(a.answer(40, pick("root@elsewhere's password: "))).toBeNull()
    expect(a.armed(50)).toBe(true)
    expect(a.answer(60, pick('(demo@127.0.0.1) Password: '))).toEqual({ kind: 'login', secret: 'fake-login' })
  })

  it('answers nothing once disarmed (the user typed)', () => {
    const a = new LoginAutoAnswer(0)
    a.disarm()
    expect(a.answer(10, pick("demo@127.0.0.1's password: "))).toBeNull()
  })

  it('does not read the secret once spent', () => {
    const a = new LoginAutoAnswer(0)
    a.disarm()
    let read = false
    a.answer(10, () => {
      read = true
      return null
    })
    expect(read).toBe(false)
  })
})

describe('LoginHold', () => {
  const LAUNCH = "clear; PROMPT_COMMAND='exit $?'; claude; exit $?\n"
  const PROMPT = "demo@127.0.0.1's password: "

  it('queues the launch line until the shell shows after the answer', () => {
    const h = new LoginHold()
    expect(h.write(LAUNCH, 'launch')).toBe(false)
    expect(h.output('Warning: Permanently added ...\r\n', false)).toBeNull()
    h.answered()
    expect(h.output('\r\n', false)).toBeNull()
    expect(h.output('Welcome to OpenSSH Server\r\nhost:~$ ', false)).toEqual([LAUNCH])
    expect(h.open).toBe(true)
    expect(h.write('x', 'user')).toBe(true)
  })

  it('holds a launch line that arrives after the answer, then flushes it', () => {
    const h = new LoginHold()
    h.answered()
    expect(h.write(LAUNCH, 'launch')).toBe(false)
    expect(h.output('\x1b[?2004h', false)).toEqual([LAUNCH])
  })

  it('never sends the launch line into a prompt after a refused answer', () => {
    const h = new LoginHold()
    h.write(LAUNCH, 'launch')
    h.answered()
    expect(h.output('\r\nPermission denied, please try again.\r\n', false)).toBeNull()
    expect(h.output(PROMPT, true)).toBeNull()
    // The user's own keys go straight to ssh: they are the password.
    expect(h.write('typed-by-user', 'user')).toBe(true)
    expect(h.write('\r', 'user')).toBe(true)
    // A later launch write still waits.
    expect(h.write('again', 'launch')).toBe(false)
    expect(h.output('\r\n', false)).toBeNull()
    expect(h.output('demo@127.0.0.1: Permission denied (publickey,password).\r\n', false)).toBeNull()
    expect(h.open).toBe(false)
  })

  it('flushes the launch line once the user logs in by hand', () => {
    const h = new LoginHold()
    h.write(LAUNCH, 'launch')
    h.answered()
    h.output(PROMPT, true)
    expect(h.output('Welcome\r\nhost:~$ ', false)).toEqual([LAUNCH])
  })

  it('drops keys typed before a prompt the user then has to answer', () => {
    const h = new LoginHold()
    expect(h.write('early', 'user')).toBe(false)
    h.write(LAUNCH, 'launch')
    expect(h.output(PROMPT, true)).toBeNull()
    expect(h.output('\x1b[?2004hhost:~$ ', false)).toEqual([LAUNCH])
  })

  it('queues keys typed after the answer and flushes them after the launch line, in order', () => {
    const h = new LoginHold()
    h.write(LAUNCH, 'launch')
    h.answered()
    expect(h.write('k', 'user')).toBe(false)
    expect(h.output('host:~$ ', false)).toEqual([LAUNCH, 'k'])
  })

  it('drops terminal query answers while held', () => {
    const h = new LoginHold()
    expect(h.write('\x1b[I', 'report')).toBe(false)
    h.answered()
    expect(h.output('host:~$ ', false)).toEqual([])
  })

  it('does not take pre-login output for the shell before any answer', () => {
    const h = new LoginHold()
    h.write(LAUNCH, 'launch')
    expect(h.output('Authorized users only.\r\n', false)).toBeNull()
    expect(h.open).toBe(false)
  })

  it('on expiry flushes away from a prompt, and waits at one', () => {
    const away = new LoginHold()
    away.write(LAUNCH, 'launch')
    expect(away.expire(false)).toEqual([LAUNCH])

    const at = new LoginHold()
    at.write(LAUNCH, 'launch')
    expect(at.expire(true)).toBeNull()
    expect(at.write('pw', 'user')).toBe(true)
    expect(at.output('host:~$ ', false)).toEqual([LAUNCH])
    expect(at.expire(false)).toBeNull()
  })

  it('through a gateway, stays held until both answers are in', () => {
    const h = new LoginHold(2)
    h.write(LAUNCH, 'launch')
    h.answered()
    // A banner between the gateway's answer and the target's prompt is not the shell.
    expect(h.output('\r\nAuthorized users only\r\n', false)).toBeNull()
    h.answered()
    expect(h.output('\r\nWelcome\r\ntarget:~$ ', false)).toEqual([LAUNCH])
  })
})

describe('LoginChain (a login through a gateway)', () => {
  const T0 = 1_000_000
  // As Windows OpenSSH prints them, captured in a node-pty run through a real gateway.
  const JUMP_PROMPT = "\x1b[?25l\x1b[2J\x1b[m\x1b[Hdemo@127.0.0.1's password:\x1b[1C\x1b]0;C:\\Windows\\System32\\OpenSSH\\ssh.exe\x07\x1b[?25h"
  const TARGET_PROMPT = "\r\ndemo2@argos-vc-target's password: "
  const secrets: Record<string, LoginHostSecrets> = {
    gw: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'gw-secret' },
    tg: { authType: 'password', username: 'demo2', host: 'argos-vc-target', password: 'target-secret' }
  }
  const of = (id: string) => secrets[id] ?? null
  const step = (id: string, canAnswer = true): LoginStep => ({
    hostId: id,
    self: { username: secrets[id].username, host: secrets[id].host },
    canAnswer
  })

  it('answers the gateway then the target, each with its own secret, once', () => {
    const c = new LoginChain([step('gw'), step('tg')], T0)
    expect(c.expected).toBe(2)
    let tail = appendTail('', JUMP_PROMPT)
    expect(c.match(tail)).not.toBeNull()
    expect(c.answer(T0 + 10, tail, of)).toEqual({ step: 0, kind: 'login', secret: 'gw-secret' })
    // The caller clears the tail after writing an answer.
    tail = appendTail('', '\r\n')
    expect(c.answer(T0 + 20, tail, of)).toBeNull()
    tail = appendTail(tail, TARGET_PROMPT)
    expect(c.answer(T0 + 30, tail, of)).toEqual({ step: 1, kind: 'login', secret: 'target-secret' })
    expect(c.armed(T0 + 40)).toBe(false)
    expect(c.answer(T0 + 50, appendTail('', TARGET_PROMPT), of)).toBeNull()
  })

  it('never answers the same gateway prompt twice, nor gives it the target secret', () => {
    const c = new LoginChain([step('gw'), step('tg')], T0)
    expect(c.answer(T0, appendTail('', JUMP_PROMPT), of)?.secret).toBe('gw-secret')
    // A wrong gateway password: ssh asks the gateway again.
    expect(c.answer(T0 + 1, appendTail('', "\r\nPermission denied, please try again.\r\ndemo@127.0.0.1's password: "), of)).toBeNull()
    expect(c.armed(T0 + 2)).toBe(false)
  })

  it('look-alike hosts: only the first prompt (the gateway asks first) is answered, the next is the user', () => {
    const same: Record<string, LoginHostSecrets> = {
      gw: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'gw-secret' },
      tg: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'target-secret' }
    }
    const s = (id: string): LoginStep => ({ hostId: id, self: { username: 'demo', host: '127.0.0.1' }, canAnswer: true })
    const c = new LoginChain([s('gw'), s('tg')], T0)
    expect(c.expected).toBe(1)
    const prompt = "demo@127.0.0.1's password: "
    expect(c.answer(T0, appendTail('', prompt), (id) => same[id])?.secret).toBe('gw-secret')
    // It could be the gateway asking again with no refusal printed: never the target's secret.
    expect(c.answer(T0 + 1, appendTail('', '\r\n' + prompt), (id) => same[id])).toBeNull()
  })

  it('look-alike by key file: the same passphrase prompt is answered once, as the gateway', () => {
    const keys: Record<string, LoginHostSecrets> = {
      gw: { authType: 'key', username: 'a', host: 'gw', passphrase: 'gw-pp' },
      tg: { authType: 'key', username: 'b', host: 'tg', passphrase: 'tg-pp' }
    }
    const k = 'C:\\Users\\me\\.ssh\\id_ed25519'
    const c = new LoginChain(
      [
        { hostId: 'gw', self: { username: 'a', host: 'gw' }, keyPath: k, canAnswer: true },
        { hostId: 'tg', self: { username: 'b', host: 'tg' }, keyPath: k, canAnswer: true }
      ],
      T0
    )
    const prompt = `Enter passphrase for key '${k}': `
    expect(c.answer(T0, appendTail('', prompt), (id) => keys[id])?.secret).toBe('gw-pp')
    expect(c.answer(T0 + 1, appendTail('', '\r\n' + prompt), (id) => keys[id])).toBeNull()
  })

  it('look-alike hosts: a refused gateway answer stops everything, so the target secret never reaches the gateway', () => {
    const s = (id: string): LoginStep => ({ hostId: id, self: { username: 'demo', host: '127.0.0.1' }, canAnswer: true })
    const same: Record<string, LoginHostSecrets> = {
      gw: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'gw-secret' },
      tg: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'target-secret' }
    }
    const c = new LoginChain([s('gw'), s('tg')], T0)
    c.answer(T0, appendTail('', "demo@127.0.0.1's password: "), (id) => same[id])
    expect(c.answer(T0 + 1, appendTail('', "\r\nPermission denied, please try again.\r\ndemo@127.0.0.1's password: "), (id) => same[id])).toBeNull()
  })

  it('a gateway without a saved secret leaves its prompt, and a look-alike target, to the user', () => {
    const s = (id: string, canAnswer: boolean): LoginStep => ({ hostId: id, self: { username: 'demo', host: '127.0.0.1' }, canAnswer })
    const same: Record<string, LoginHostSecrets> = {
      gw: { authType: 'password', username: 'demo', host: '127.0.0.1' },
      tg: { authType: 'password', username: 'demo', host: '127.0.0.1', password: 'target-secret' }
    }
    const c = new LoginChain([s('gw', false), s('tg', true)], T0)
    // Nothing can be answered safely, so the terminal arms no answer at all.
    expect(c.expected).toBe(0)
    expect(c.answer(T0, appendTail('', "demo@127.0.0.1's password: "), (id) => same[id])).toBeNull()
  })

  it('answers a target prompt that names its HostKeyAlias, with the target secret', () => {
    const alias = 'argos-jump-0123456789abcdef0123456789abcdef'
    const c = new LoginChain([step('gw'), { hostId: 'tg', self: { username: 'demo2', host: alias }, canAnswer: true }], T0)
    expect(c.answer(T0, appendTail('', JUMP_PROMPT), of)?.secret).toBe('gw-secret')
    expect(c.answer(T0 + 1, appendTail('', `\r\ndemo2@${alias}'s password: `), of)).toEqual({ step: 1, kind: 'login', secret: 'target-secret' })
  })

  it('answers only the target when only it has a secret', () => {
    const c = new LoginChain([step('gw', false), step('tg')], T0)
    expect(c.answer(T0, appendTail('', JUMP_PROMPT), of)).toBeNull()
    expect(c.answer(T0 + 1, appendTail('', TARGET_PROMPT), of)).toEqual({ step: 1, kind: 'login', secret: 'target-secret' })
  })

  it('does not answer a bare Password: through a gateway, as it names neither host', () => {
    const c = new LoginChain([step('gw'), step('tg')], T0)
    expect(c.match(appendTail('', 'Password: '))).not.toBeNull()
    expect(c.answer(T0, appendTail('', 'Password: '), of)).toBeNull()
    // A single host still takes it, as before.
    const single = new LoginChain([step('tg')], T0)
    expect(single.answer(T0, appendTail('', 'Password: '), of)?.secret).toBe('target-secret')
  })

  it("gives each host's passphrase only to its own key's prompt", () => {
    const keys: Record<string, LoginHostSecrets> = {
      gw: { authType: 'key', username: 'demo', host: '127.0.0.1', passphrase: 'gw-pp' },
      tg: { authType: 'key', username: 'demo2', host: 'argos-vc-target', passphrase: 'tg-pp' }
    }
    const steps: LoginStep[] = [
      { hostId: 'gw', self: { username: 'demo', host: '127.0.0.1' }, keyPath: 'C:\\Users\\me\\.ssh\\gw_key', canAnswer: true },
      { hostId: 'tg', self: { username: 'demo2', host: 'argos-vc-target' }, keyPath: 'C:\\Users\\me\\.ssh\\tg_key', canAnswer: true }
    ]
    const c = new LoginChain(steps, T0)
    expect(c.answer(T0, appendTail('', "Enter passphrase for key 'C:\\Users\\me\\.ssh\\tg_key': "), (id) => keys[id])).toEqual({
      step: 1,
      kind: 'passphrase',
      secret: 'tg-pp'
    })
    expect(c.answer(T0 + 1, appendTail('', "Enter passphrase for key 'C:\\Users\\me\\.ssh\\gw_key': "), (id) => keys[id])?.secret).toBe('gw-pp')
  })

  it('runs out with the login window and when disarmed', () => {
    const late = new LoginChain([step('gw'), step('tg')], T0)
    expect(late.answer(T0 + LOGIN_WINDOW_MS + 1, appendTail('', JUMP_PROMPT), of)).toBeNull()
    const typed = new LoginChain([step('gw'), step('tg')], T0)
    typed.disarm()
    expect(typed.answer(T0, appendTail('', JUMP_PROMPT), of)).toBeNull()
  })
})
