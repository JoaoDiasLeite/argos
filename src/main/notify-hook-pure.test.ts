import { describe, it, expect } from 'vitest'
import {
  baseName,
  buildDeepLink,
  decodeNotifyPayload,
  encodeNotifyPayload,
  encodedDirFor,
  extractDeepLink,
  hookSettingsBlock,
  isUrgent,
  notificationTitle,
  notifyHookCommand,
  notifyHookInstalled,
  notifyHookMode,
  parseDeepLink,
  parseHookInput,
  projectLabel,
  sanitizeSessionId,
  wslHookCommand
} from './notify-hook-pure'

const SID = '9f2c1a40-3b7e-4d21-8f0a-6c5b2e1d7a33'

describe('parseHookInput', () => {
  it('reads the fields the notification is built from', () => {
    const input = parseHookInput(
      JSON.stringify({
        message: 'Claude needs your permission to use Bash',
        cwd: '/home/jdl/secops/friday',
        transcript_path: `/home/jdl/.claude/projects/-home-jdl-secops-friday/${SID}.jsonl`,
        session_id: SID,
        notification_type: 'permission_prompt'
      })
    )
    expect(input).toEqual({
      message: 'Claude needs your permission to use Bash',
      cwd: '/home/jdl/secops/friday',
      transcriptPath: `/home/jdl/.claude/projects/-home-jdl-secops-friday/${SID}.jsonl`,
      sessionId: SID,
      notificationType: 'permission_prompt'
    })
  })

  it('returns null for anything that is not a JSON object', () => {
    expect(parseHookInput('')).toBeNull()
    expect(parseHookInput('not json')).toBeNull()
    expect(parseHookInput('[1,2]')).toBeNull()
    expect(parseHookInput('"a string"')).toBeNull()
  })

  it('leaves missing fields empty rather than undefined', () => {
    expect(parseHookInput('{}')).toEqual({
      message: '',
      cwd: '',
      transcriptPath: '',
      sessionId: '',
      notificationType: ''
    })
  })
})

describe('sanitizeSessionId', () => {
  it('keeps a real session id', () => {
    expect(sanitizeSessionId(SID)).toBe(SID)
  })

  // The id reaches a URL as a query parameter. Anything that could add parameters of
  // its own is dropped rather than escaped — a value needing escaping is not an id.
  it('blanks anything outside [0-9a-f-]', () => {
    expect(sanitizeSessionId('abc&p=evil')).toBe('')
    expect(sanitizeSessionId('../../etc/passwd')).toBe('')
    expect(sanitizeSessionId('abc def')).toBe('')
    expect(sanitizeSessionId('')).toBe('')
  })
})

describe('baseName / projectLabel', () => {
  it('handles both separators, because the hook can fire on either side', () => {
    expect(baseName('/home/jdl/secops/friday')).toBe('friday')
    expect(baseName('C:\\Users\\jdl\\Projetos\\argos')).toBe('argos')
    expect(baseName('/home/jdl/secops/friday/')).toBe('friday')
    expect(baseName('')).toBe('')
  })

  it('names the project after its working directory', () => {
    expect(projectLabel('C:\\Users\\jdl\\Projetos\\argos')).toBe('argos')
  })
})

describe('encodedDirFor', () => {
  it('is the transcript\u2019s parent directory', () => {
    expect(encodedDirFor(`/home/jdl/.claude/projects/-home-jdl-secops-friday/${SID}.jsonl`)).toBe(
      '-home-jdl-secops-friday'
    )
    expect(
      encodedDirFor(`C:\\Users\\jdl\\.claude\\projects\\C--Users-jdl-argos\\${SID}.jsonl`)
    ).toBe('C--Users-jdl-argos')
  })

  // Archiving moves the file into a subdirectory of the project — it is not a flag —
  // so the project is one level further up for an archived conversation.
  it('steps over an archived/ subdirectory', () => {
    expect(encodedDirFor(`/home/jdl/.claude/projects/-home-jdl-x/archived/${SID}.jsonl`)).toBe(
      '-home-jdl-x'
    )
  })

  it('is empty when there is no parent to name', () => {
    expect(encodedDirFor('')).toBe('')
    expect(encodedDirFor('session.jsonl')).toBe('')
  })
})

describe('notificationTitle', () => {
  it('names project and conversation', () => {
    expect(notificationTitle('argos', 'Port the notification hook')).toBe(
      '[argos] Port the notification hook'
    )
  })

  it('collapses newlines — a toast is one line', () => {
    expect(notificationTitle('argos', 'first line\nsecond   line')).toBe(
      '[argos] first line second line'
    )
  })

  it('clamps a conversation that is really a paragraph', () => {
    const long = 'x'.repeat(200)
    expect(notificationTitle('argos', long)).toBe(`[argos] ${'x'.repeat(60)}`)
  })

  it('degrades to whichever half it has', () => {
    expect(notificationTitle('', 'just a conversation')).toBe('just a conversation')
    expect(notificationTitle('argos', '')).toBe('[argos]')
  })
})

describe('buildDeepLink / parseDeepLink', () => {
  it('round-trips a target', () => {
    const link = buildDeepLink({ encodedDir: '-home-jdl-x', sessionId: SID, sourceId: 'wsl:Ubuntu' })
    expect(link).toBe(`argos://session?dir=-home-jdl-x&sid=${SID}&src=wsl%3AUbuntu`)
    expect(parseDeepLink(link!)).toEqual({
      encodedDir: '-home-jdl-x',
      sessionId: SID,
      sourceId: 'wsl:Ubuntu'
    })
  })

  it('omits a source it was not given', () => {
    const link = buildDeepLink({ encodedDir: '-home-jdl-x', sessionId: SID })!
    expect(link).not.toContain('src=')
    expect(parseDeepLink(link)).toEqual({ encodedDir: '-home-jdl-x', sessionId: SID })
  })

  it('refuses ids that would not address a file', () => {
    expect(buildDeepLink({ encodedDir: '-ok', sessionId: 'nope!' })).toBeNull()
    expect(buildDeepLink({ encodedDir: '../escape', sessionId: SID })).toBeNull()
  })

  // Anything on the machine can invoke a registered protocol, so the link is
  // re-validated on the way in, not trusted because we usually write it.
  it('rejects a link that arrives with hostile ids', () => {
    expect(parseDeepLink(`argos://session?dir=..%2F..%2Fetc&sid=${SID}`)).toBeNull()
    expect(parseDeepLink('argos://session?dir=-ok&sid=%2e%2e%2f')).toBeNull()
    expect(parseDeepLink(`argos://other?dir=-ok&sid=${SID}`)).toBeNull()
    expect(parseDeepLink(`http://session?dir=-ok&sid=${SID}`)).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
  })

  it('drops a source id that is not one, keeping the rest of the target', () => {
    expect(parseDeepLink(`argos://session?dir=-ok&sid=${SID}&src=a%2Fb`)).toEqual({
      encodedDir: '-ok',
      sessionId: SID
    })
  })
})

describe('extractDeepLink', () => {
  it('finds the link among a launch\u2019s other arguments', () => {
    expect(
      extractDeepLink(['C:\\Argos.exe', '--hidden', `argos://session?dir=-ok&sid=${SID}`])
    ).toEqual({ encodedDir: '-ok', sessionId: SID })
  })

  it('is null for a normal launch, and for a malformed link', () => {
    expect(extractDeepLink(['C:\\Argos.exe', '--new-chat'])).toBeNull()
    expect(extractDeepLink(['argos://session?dir=&sid='])).toBeNull()
  })
})

describe('the pasted block', () => {
  it('quotes the executable and passes only the flag', () => {
    expect(notifyHookCommand('C:\\Program Files\\Argos\\Argos.exe')).toBe(
      '"C:\\Program Files\\Argos\\Argos.exe" --notify-hook'
    )
  })

  it('carries the app directory in dev, where the exe is electron.exe', () => {
    expect(notifyHookCommand('C:\\electron.exe', 'C:\\repo\\argos')).toBe(
      '"C:\\electron.exe" "C:\\repo\\argos" --notify-hook'
    )
  })

  it('translates the executable for a session inside a distro', () => {
    expect(wslHookCommand('C:\\Users\\jdl\\AppData\\Local\\Argos\\Argos.exe')).toBe(
      '"/mnt/c/Users/jdl/AppData/Local/Argos/Argos.exe" --notify-hook'
    )
    expect(wslHookCommand('/usr/lib/argos/argos')).toBeNull()
  })

  it('is a Notification hook with an empty matcher — every session, not a tool', () => {
    const block = JSON.parse(hookSettingsBlock('cmd'))
    expect(block).toEqual({
      hooks: { Notification: [{ matcher: '', hooks: [{ type: 'command', command: 'cmd' }] }] }
    })
  })
})

describe('notifyHookInstalled', () => {
  const withCommand = (command: string) => ({
    Notification: [{ matcher: '', hooks: [{ type: 'command', command }] }]
  })

  // Matched on the flag: the exe path changes with every install location, and an
  // equality test against ours would report "not installed" forever.
  it('recognises the hook wherever it was installed from', () => {
    expect(notifyHookInstalled(withCommand('"D:\\Old\\Argos.exe" --notify-hook'))).toBe(true)
  })

  it('is false for other hooks, and for nothing at all', () => {
    expect(notifyHookInstalled(withCommand('notify-send hello'))).toBe(false)
    expect(notifyHookInstalled({ PreToolUse: [] })).toBe(false)
    expect(notifyHookInstalled({})).toBe(false)
    expect(notifyHookInstalled(null)).toBe(false)
  })
})

describe('the payload handed to the detached process', () => {
  const payload = { title: '[argos] Hi', body: 'needs you', link: `argos://session?dir=-ok&sid=${SID}`, urgent: true }

  it('round-trips', () => {
    expect(decodeNotifyPayload(encodeNotifyPayload(payload))).toEqual(payload)
  })

  // Argv is not trusted just because we usually write it: this is where a string
  // becomes a URL the app will open.
  it('drops a link that does not validate, keeping the notification', () => {
    const bad = decodeNotifyPayload(
      encodeNotifyPayload({ ...payload, link: 'https://evil.example/x' })
    )
    expect(bad).toEqual({ ...payload, link: '' })
  })

  it('is null for junk and for a payload with nothing to say', () => {
    expect(decodeNotifyPayload('not base64 json')).toBeNull()
    expect(decodeNotifyPayload(encodeNotifyPayload({ ...payload, title: '' }))).toBeNull()
  })
})

describe('notifyHookMode', () => {
  it('is null for a normal launch', () => {
    expect(notifyHookMode(['C:\\Argos.exe'])).toBeNull()
    expect(notifyHookMode(['C:\\Argos.exe', '--hidden'])).toBeNull()
  })

  it('reads the relay role', () => {
    expect(notifyHookMode(['C:\\Argos.exe', '--notify-hook'])).toEqual({ kind: 'relay' })
  })

  it('reads the detached role with its payload', () => {
    const encoded = encodeNotifyPayload({ title: 't', body: 'b', link: '', urgent: false })
    expect(notifyHookMode(['C:\\Argos.exe', '--notify-hook-show', encoded])).toEqual({
      kind: 'show',
      payload: { title: 't', body: 'b', link: '', urgent: false }
    })
  })

  // Falling through would boot the whole application — windows, tray, scheduler —
  // because one notification arrived malformed.
  it('aborts rather than falling through when the payload is unusable', () => {
    expect(notifyHookMode(['C:\\Argos.exe', '--notify-hook-show', 'garbage'])).toEqual({
      kind: 'abort'
    })
    expect(notifyHookMode(['C:\\Argos.exe', '--notify-hook-show'])).toEqual({ kind: 'abort' })
  })
})

describe('isUrgent', () => {
  it('is only the notification that blocks a session', () => {
    expect(isUrgent('permission_prompt')).toBe(true)
    expect(isUrgent('idle')).toBe(false)
    expect(isUrgent('')).toBe(false)
  })
})
