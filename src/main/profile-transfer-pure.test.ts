import { describe, it, expect } from 'vitest'
import { gzipSync } from 'zlib'
import { PassThrough, Readable } from 'stream'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  BundleWriter,
  candidateKey,
  chatSourceId,
  decryptSecrets,
  defaultExportName,
  encodeLine,
  encryptSecrets,
  isFileLine,
  isTranscriptRel,
  openBundle,
  parseLine,
  fileEntry,
  makePathRemapper,
  mergeAccountGroup,
  mergeHosts,
  mergeStore,
  mergeTrust,
  projectPathKey,
  remapStore,
  safeMdName,
  safeRel,
  selectChats,
  splitHostSecrets,
  stripLocalStoreKeys,
  type BundleHeader,
  type BundleLine
} from './profile-transfer-pure'

const FROM_HOME = 'C:\\Users\\JoãoLeite'
const TO_HOME = 'C:\\Users\\jdl'
const FROM_UD = 'C:\\Users\\JoãoLeite\\AppData\\Roaming\\argos'
const TO_UD = 'C:\\Users\\jdl\\AppData\\Roaming\\argos'

const win = (): ReturnType<typeof makePathRemapper> =>
  makePathRemapper(
    [
      { from: FROM_UD, to: TO_UD },
      { from: FROM_HOME, to: TO_HOME }
    ],
    true
  )

const HEADER: BundleHeader = {
  format: BUNDLE_FORMAT,
  version: BUNDLE_VERSION,
  createdAt: 1,
  appVersion: '2.8.0',
  platform: 'win32',
  home: FROM_HOME,
  userData: FROM_UD
}

async function writeBundle(lines: (BundleHeader | BundleLine)[]): Promise<Buffer> {
  const out = new PassThrough()
  const chunks: Buffer[] = []
  out.on('data', (c: Buffer) => chunks.push(c))
  const writer = new BundleWriter(out)
  for (const l of lines) await writer.write(l)
  await writer.end()
  return Buffer.concat(chunks)
}

async function readAll(buf: Buffer, skipFiles = false): Promise<{ header: BundleHeader; lines: (BundleLine | null)[] }> {
  const opened = await openBundle(Readable.from([buf]), { skipFiles })
  const lines: (BundleLine | null)[] = []
  for await (const l of opened.lines) lines.push(l)
  return { header: opened.header, lines }
}

async function errorOf(p: Promise<unknown>): Promise<BundleError> {
  try {
    await p
  } catch (e) {
    if (e instanceof BundleError) return e
    throw e
  }
  throw new Error('expected a BundleError')
}

describe('path remap', () => {
  it('rewrites a backslash path', () => {
    expect(win().value('C:\\Users\\JoãoLeite\\Desktop\\proj')).toBe('C:\\Users\\jdl\\Desktop\\proj')
  })

  it('rewrites a forward-slash path, keeping its spelling', () => {
    expect(win().value('C:/Users/JoãoLeite/Desktop/proj')).toBe('C:/Users/jdl/Desktop/proj')
  })

  it('rewrites the root itself', () => {
    expect(win().value('C:\\Users\\JoãoLeite')).toBe('C:\\Users\\jdl')
  })

  it('prefers the more specific userData root', () => {
    expect(win().value(`${FROM_UD}\\exports\\chats\\a.md`)).toBe(`${TO_UD}\\exports\\chats\\a.md`)
  })

  it('is prefix-only and stops at a path boundary', () => {
    const r = win()
    expect(r.value('C:\\Users\\JoãoLeiteX\\proj')).toBe('C:\\Users\\JoãoLeiteX\\proj')
    expect(r.value('D:\\backup\\C:\\Users\\JoãoLeite\\x')).toBe('D:\\backup\\C:\\Users\\JoãoLeite\\x')
    expect(r.value('/home/jdl/dev')).toBe('/home/jdl/dev')
  })

  it('is case-insensitive on Windows only', () => {
    expect(win().value('c:\\users\\joãoleite\\proj')).toBe('C:\\Users\\jdl\\proj')
    const posix = makePathRemapper([{ from: '/home/a', to: '/home/b' }], false)
    expect(posix.value('/home/a/x')).toBe('/home/b/x')
    expect(posix.value('/HOME/a/x')).toBe('/HOME/a/x')
  })

  it('rewrites JSON-escaped and forward paths inside JSONL text, prefix-only', () => {
    const line =
      '{"cwd":"C:\\\\Users\\\\JoãoLeite\\\\proj","file":"C:/Users/JoãoLeite/proj/a.ts","cmd":"cd C:\\\\Users\\\\JoãoLeite","other":"C:\\\\Users\\\\JoãoLeiteX"}'
    const out = win().text(line)
    const parsed = JSON.parse(out)
    expect(parsed.cwd).toBe('C:\\Users\\jdl\\proj')
    expect(parsed.file).toBe('C:/Users/jdl/proj/a.ts')
    expect(parsed.cmd).toBe('cd C:\\Users\\JoãoLeite')
    expect(parsed.other).toBe('C:\\Users\\JoãoLeiteX')
  })

  it('rewrites a root whose non-ASCII characters are \\u-escaped in the text', () => {
    const line = '{"cwd":"C:\\\\Users\\\\Jo\\u00e3oLeite\\\\proj"}'
    expect(JSON.parse(win().text(line)).cwd).toBe('C:\\Users\\jdl\\proj')
  })

  it('rewrites a whole-string root in text and never reads $ as a substitution', () => {
    const r = makePathRemapper([{ from: 'C:\\Users\\a', to: 'C:\\Users\\$&b' }], true)
    expect(JSON.parse(r.text('{"x":"C:\\\\Users\\\\a"}')).x).toBe('C:\\Users\\$&b')
  })

  it('walks parsed JSON values', () => {
    const rec = { projectPath: 'C:/Users/JoãoLeite/p', archivedTranscript: `${FROM_UD}\\exports\\chats\\x.md`, n: 3, list: ['C:\\Users\\JoãoLeite'] }
    expect(win().deep(rec)).toEqual({
      projectPath: 'C:/Users/jdl/p',
      archivedTranscript: `${TO_UD}\\exports\\chats\\x.md`,
      n: 3,
      list: ['C:\\Users\\jdl']
    })
  })

  it('rewrites encoded project dirs', () => {
    expect(win().encoded('C--Users-Jo-oLeite-Desktop-proj')).toBe('C--Users-jdl-Desktop-proj')
    expect(win().encoded('C--Users-Jo-oLeiteX')).toBe('C--Users-Jo-oLeiteX')
  })

  it('is an identity with no pairs or equal roots', () => {
    expect(makePathRemapper([], true).identity).toBe(true)
    expect(makePathRemapper([{ from: 'C:\\Users\\a', to: 'c:/users/a/' }], true).identity).toBe(true)
  })
})

describe('remapStore', () => {
  it('re-keys project names and project pref keys', () => {
    const out = remapStore(
      {
        'project-names': { 'c:/users/joãoleite/desktop/argos': 'Argos', '//wsl.localhost/u/home/x': 'X' },
        favoriteProjects: ['local:C--Users-Jo-oLeite-Desktop-argos', 'wsl:Ubuntu:-home-jdl-dev'],
        archivedProjects: ['account:acc_1:C--Users-Jo-oLeite-old']
      },
      win()
    )
    expect(out['project-names']).toEqual({ 'c:/users/jdl/desktop/argos': 'Argos', '//wsl.localhost/u/home/x': 'X' })
    expect(out.favoriteProjects).toEqual(['local:C--Users-jdl-Desktop-argos', 'wsl:Ubuntu:-home-jdl-dev'])
    expect(out.archivedProjects).toEqual(['account:acc_1:C--Users-jdl-old'])
  })
})

describe('mergeStore', () => {
  it('merges objects, unions arrays, imported scalars win, local-only keys stay out', () => {
    const local = { labels: { a: 1, b: 2 }, hiddenDistros: ['docker'], x: 1, usageCache: { mine: true }, keep: 'me' }
    const imported = { labels: { b: 3, c: 4 }, hiddenDistros: ['docker', 'kali'], x: 2, usageCache: { theirs: true }, sessionMigration: {} }
    expect(mergeStore(local, imported)).toEqual({
      labels: { a: 1, b: 3, c: 4 },
      hiddenDistros: ['docker', 'kali'],
      x: 2,
      usageCache: { mine: true },
      keep: 'me'
    })
  })

  it('strips machine-local keys on export', () => {
    expect(stripLocalStoreKeys({ usageCache: 1, sessionMigration: 2, labels: 3 })).toEqual({ labels: 3 })
  })
})

describe('mergeAccountGroup', () => {
  const dir = (id: string): string => `C:\\ud\\cc-accounts\\${id}`

  it('adds new accounts with a fresh config dir and keeps existing dirs', () => {
    const local = {
      accounts: [
        { id: 'default', name: 'Default', configDir: null, isDefault: true },
        { id: 'acc_1', name: 'Old', configDir: 'C:\\here\\acc_1', isDefault: false }
      ],
      defaultAccountId: 'default'
    }
    const imported = {
      accounts: [
        { id: 'default', name: 'Work', configDir: null, isDefault: true },
        { id: 'acc_1', name: 'Personal', configDir: 'C:\\there\\acc_1', isDefault: false },
        { id: 'acc_2', name: 'Client', configDir: 'C:\\there\\acc_2', isDefault: false }
      ],
      defaultAccountId: 'acc_2'
    }
    const { group, created } = mergeAccountGroup(local, imported, dir)
    expect(group.accounts).toEqual([
      { id: 'default', name: 'Work', configDir: null, isDefault: true },
      { id: 'acc_1', name: 'Personal', configDir: 'C:\\here\\acc_1', isDefault: false },
      { id: 'acc_2', name: 'Client', configDir: dir('acc_2'), isDefault: false }
    ])
    expect(created).toEqual([dir('acc_2')])
    // This machine had more than the default: its choice stays.
    expect(group.defaultAccountId).toBe('default')
  })

  it("takes the imported default when this machine only had the built-in account", () => {
    const { group } = mergeAccountGroup(
      { accounts: [{ id: 'default', name: 'Default', configDir: null, isDefault: true }], defaultAccountId: 'default' },
      { accounts: [{ id: 'acc_2', name: 'Client', configDir: 'x', isDefault: false }], defaultAccountId: 'acc_2' },
      dir
    )
    expect(group.defaultAccountId).toBe('acc_2')
  })

  it('works with nothing local', () => {
    const { group } = mergeAccountGroup(undefined, { accounts: [{ id: 'default', name: 'Work', configDir: null, isDefault: true }], defaultAccountId: 'default' }, dir)
    expect(group.accounts).toEqual([{ id: 'default', name: 'Work', configDir: null, isDefault: true }])
  })
})

describe('hosts', () => {
  it('splits secrets out and merges by id keeping local secrets the import lacks', () => {
    const { hosts, secrets } = splitHostSecrets([
      { id: 'h1', name: 'a', password: 'pw' },
      { id: 'h2', name: 'b' }
    ])
    expect(hosts).toEqual([{ id: 'h1', name: 'a' }, { id: 'h2', name: 'b' }])
    expect(secrets).toEqual({ h1: { password: 'pw' } })

    const merged = mergeHosts(
      [{ id: 'h1', name: 'old', password: 'local' }, { id: 'h3', name: 'c' }] as { id: string; name: string; password?: string; passphrase?: string }[],
      [{ id: 'h1', name: 'new' }, { id: 'h2', name: 'b', passphrase: 'pp' }]
    )
    expect(merged).toEqual([
      { id: 'h1', name: 'new', password: 'local' },
      { id: 'h3', name: 'c' },
      { id: 'h2', name: 'b', passphrase: 'pp' }
    ])
  })

  it('keeps this machine trusted keys over imported ones', () => {
    expect(mergeTrust({ a: 'mine' }, { a: 'theirs', b: 'new' })).toEqual({ a: 'mine', b: 'new' })
  })
})

describe('secrets', () => {
  it('round-trips with the right passphrase', async () => {
    const enc = await encryptSecrets({ ssh: { h1: { password: 'pw' } }, apiKey: 'sk-1' }, 'correct horse')
    expect(enc.kdf).toBe('scrypt')
    expect(enc.data).not.toContain('pw')
    expect(await decryptSecrets(enc, 'correct horse')).toEqual({ ssh: { h1: { password: 'pw' } }, apiKey: 'sk-1' })
  })

  it('returns null for a wrong passphrase or a tampered envelope', async () => {
    const enc = await encryptSecrets({ ssh: {} }, 'right')
    expect(await decryptSecrets(enc, 'wrong')).toBeNull()
    const data = Buffer.from(enc.data, 'base64')
    data[0] ^= 1
    expect(await decryptSecrets({ ...enc, data: data.toString('base64') }, 'right')).toBeNull()
  })
})

describe('bundle stream', () => {
  const profile: BundleLine = { type: 'profile', json: { 'config.json': { a: 1 } }, dirs: {}, sshHosts: [] }
  const project: BundleLine = {
    type: 'project',
    index: 0,
    sourceId: 'local',
    sourceLabel: 'Local',
    provider: 'claude',
    kind: 'local',
    accountId: 'default',
    realPath: 'C:\\p',
    encodedDir: 'C--p',
    files: 1,
    transcripts: 1
  }

  it('round-trips header, profile, chats, projects and files, including a line larger than a chunk', async () => {
    const big = 'olá ção '.repeat(400_000) // ~3.6 MB with multi-byte characters across chunk edges
    const lines: BundleLine[] = [
      profile,
      { type: 'chat', record: { id: 'x' } },
      project,
      { type: 'file', project: 0, rel: 'a.jsonl', text: big }
    ]
    const { header, lines: read } = await readAll(await writeBundle([HEADER, ...lines]))
    expect(header).toEqual(HEADER)
    expect(read).toEqual(lines)
  })

  it('skips file lines unparsed when asked', async () => {
    const buf = await writeBundle([HEADER, profile, project, { type: 'file', project: 0, rel: 'a.jsonl', text: 'x' }])
    const { lines } = await readAll(buf, true)
    expect(lines).toEqual([profile, project, null])
  })

  it('puts type first so file lines are recognisable raw', () => {
    expect(isFileLine(encodeLine({ type: 'file', project: 0, rel: 'a', text: 'b' }))).toBe(true)
    expect(isFileLine(encodeLine({ type: 'chat', record: { text: '{"type":"file"' } }))).toBe(false)
  })

  it('rejects a file that is not gzip, not JSON, or not an Argos profile', async () => {
    expect((await errorOf(readAll(Buffer.from('hello')))).code).toBe('not-argos')
    expect((await errorOf(readAll(gzipSync('{nope\n')))).code).toBe('not-argos')
    expect((await errorOf(readAll(gzipSync(JSON.stringify({ format: 'other' }) + '\n')))).code).toBe('not-argos')
    expect((await errorOf(readAll(Buffer.alloc(0)))).code).toBe('not-argos')
  })

  it('rejects another format version with the version it saw', async () => {
    const e = await errorOf(readAll(gzipSync(JSON.stringify({ ...HEADER, version: 1 }) + '\n')))
    expect(e.code).toBe('unsupported-version')
    expect(e.version).toBe(1)
  })

  it('reports a damaged body line or a truncated file as corrupt', async () => {
    const bad = gzipSync(encodeLine(HEADER) + '{"type":"nope"}\n')
    expect((await errorOf(readAll(bad))).code).toBe('corrupt')
    const whole = await writeBundle([HEADER, profile, project, { type: 'file', project: 0, rel: 'a', text: 'x'.repeat(200_000) }])
    expect((await errorOf(readAll(whole.subarray(0, whole.length - 20)))).code).toBe('corrupt')
  })

  it('validates the fields each line type needs', () => {
    expect(() => parseLine('{"type":"file","project":0,"rel":"a"}')).toThrow(BundleError)
    expect(() => parseLine('{"type":"project","index":0}')).toThrow(BundleError)
    expect(() => parseLine('{"type":"chat"}')).toThrow(BundleError)
    expect(parseLine('{"type":"profile"}')).toEqual({ type: 'profile', json: {}, dirs: {}, sshHosts: [] })
  })

  it('counts transcripts the same way for export and preview', () => {
    expect(isTranscriptRel('a.jsonl', 'claude')).toBe(true)
    expect(isTranscriptRel('archived/a.jsonl', 'claude')).toBe(true)
    expect(isTranscriptRel('a/subagents/b.jsonl', 'claude')).toBe(false)
    expect(isTranscriptRel('sessions/2026/01/02/r.jsonl', 'codex')).toBe(true)
  })

  it('stores non-UTF-8 files as base64', () => {
    expect(fileEntry('a.jsonl', Buffer.from('olá', 'utf8'))).toEqual({ rel: 'a.jsonl', text: 'olá' })
    const bin = Buffer.from([0xff, 0xfe, 0x00])
    expect(fileEntry('b.bin', bin)).toEqual({ rel: 'b.bin', text: bin.toString('base64'), encoding: 'base64' })
  })
})

describe('safety', () => {
  it('accepts only relative paths that stay inside', () => {
    expect(safeRel('archived/a.jsonl')).toBe('archived/a.jsonl')
    expect(safeRel('sessions\\2026\\01\\r.jsonl')).toBe('sessions/2026/01/r.jsonl')
    expect(safeRel('../x')).toBeNull()
    expect(safeRel('a/../../x')).toBeNull()
    expect(safeRel('C:\\x')).toBeNull()
    expect(safeRel('/etc/passwd')).toBeNull()
    expect(safeRel('')).toBeNull()
  })

  it('accepts only plain .md names for archived chats', () => {
    expect(safeMdName('2026-09-15-chat-abc.md')).toBe('2026-09-15-chat-abc.md')
    expect(safeMdName('../x.md')).toBeNull()
    expect(safeMdName('x.txt')).toBeNull()
  })
})

describe('chat selection', () => {
  const defaults = { claudeAccountId: 'default', codexAccountId: 'default' }

  it('names the source a chat lives in', () => {
    expect(chatSourceId({ projectPath: 'C:/p', provider: 'claude' }, defaults)).toBe('local')
    expect(chatSourceId({ projectPath: 'C:/p', accountId: 'acc_1' }, defaults)).toBe('account:acc_1')
    expect(chatSourceId({ projectPath: 'C:/p', provider: 'claude' }, { ...defaults, claudeAccountId: 'acc_9' })).toBe('account:acc_9')
    expect(chatSourceId({ projectPath: 'C:/p', provider: 'codex' }, defaults)).toBe('codex')
    expect(chatSourceId({ projectPath: 'C:/p', provider: 'codex', codexAccountId: 'pacc_1' }, defaults)).toBe('codex:pacc_1')
    expect(chatSourceId({ projectPath: '/home/x', wslDistro: 'Ubuntu' }, defaults)).toBe('wsl:Ubuntu')
    expect(chatSourceId({ remoteHostId: 'h1' }, defaults)).toBeNull()
  })

  it('normalises project paths for comparison', () => {
    expect(projectPathKey('C:\\Users\\X\\Proj\\', { wsl: false, windows: true })).toBe('c:/users/x/proj')
    expect(projectPathKey('\\\\wsl.localhost\\Ubuntu\\home\\jdl\\dev', { wsl: true, windows: true })).toBe('/home/jdl/dev')
    expect(projectPathKey('\\\\wsl$\\Ubuntu\\home\\jdl\\dev', { wsl: true, windows: true })).toBe('/home/jdl/dev')
  })

  it('keeps chats of the selected projects and source, and remote ones only when asked', () => {
    const records = [
      { id: 'a', projectPath: 'C:/Users/X/argos', accountId: 'acc_1', provider: 'claude' },
      { id: 'b', projectPath: 'C:/Users/X/argos', provider: 'claude' }, // default account: other source
      { id: 'c', projectPath: '\\\\wsl.localhost\\Ubuntu\\home\\jdl\\dev', wslDistro: 'Ubuntu', provider: 'claude' },
      { id: 'd', remoteHostId: 'h1', projectPath: '/srv/app' },
      { id: 'e', projectPath: 'C:/Users/X/other', accountId: 'acc_1' },
      { id: 'f', projectPath: 'c:\\users\\x\\argos', provider: 'gemini' }
    ]
    const selected = [
      { sourceId: 'account:acc_1', kind: 'local' as const, realPath: 'C:\\Users\\X\\argos' },
      { sourceId: 'wsl:Ubuntu', kind: 'wsl' as const, realPath: '/home/jdl/dev' }
    ]
    const ids = (includeRemote: boolean): string[] =>
      selectChats(records, selected, { includeRemote, windows: true, ...defaults }).map((r) => r.id as string)
    expect(ids(false)).toEqual(['a', 'c', 'f'])
    expect(ids(true)).toEqual(['a', 'c', 'd', 'f'])
  })

  it('keys candidates by source and dir', () => {
    expect(candidateKey('account:acc_1', 'C--x')).toBe('account:acc_1::C--x')
  })
})

describe('defaultExportName', () => {
  it('is dated', () => {
    expect(defaultExportName(new Date(2026, 9, 9))).toBe('argos-profile-2026-10-09.argos')
  })
})
