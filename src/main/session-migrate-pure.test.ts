import { describe, expect, it } from 'vitest'
import {
  LegacySession,
  STRIPPED_FIELDS,
  exportFileName,
  migrateSession,
  providerOf,
  upgradeSession,
  sessionToMarkdown
} from './session-migrate-pure'

const T0 = new Date(2026, 5, 3, 9, 15).getTime()
const time = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
const day = (ts: number): string =>
  new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })

function fixture(over: Partial<LegacySession> = {}): LegacySession {
  return {
    id: 'abc-123',
    name: 'Fix the TLS handshake!',
    createdAt: T0,
    updatedAt: T0 + 120_000,
    projectPath: 'C:/work/argos',
    model: 'claude-opus-5',
    claudeSessionId: 'cc-1',
    messages: [
      { role: 'user', content: 'Why does it fail?', timestamp: T0 },
      {
        role: 'assistant',
        content: 'Let me look.',
        timestamp: T0 + 60_000,
        toolCalls: [
          { id: 't1', tool: 'Read', input: { file_path: 'src/tls.ts' }, result: 'x' },
          { id: 't2', tool: 'TodoWrite', input: { todos: [] } }
        ],
        usage: { inputTokens: 1, outputTokens: 2 }
      },
      { role: 'user', content: 'Thanks', timestamp: T0 + 120_000 }
    ],
    ...over
  }
}

function withAllStripped(): LegacySession {
  const s = fixture()
  for (const k of STRIPPED_FIELDS) if (!(k in s)) (s as Record<string, unknown>)[k] = 'x'
  return s
}

describe('providerOf', () => {
  it('maps model ids to providers', () => {
    expect(providerOf('claude-opus-5')).toBe('claude')
    expect(providerOf('claude-sonnet-4-6[1m]')).toBe('claude')
    expect(providerOf('gpt-5.6-sol')).toBe('codex')
    expect(providerOf('gpt-5.4')).toBe('codex')
    expect(providerOf('gemini-3.1-pro-preview')).toBe('gemini')
    expect(providerOf(undefined)).toBe('claude')
    expect(providerOf('')).toBe('claude')
    expect(providerOf('something-unknown')).toBe('claude')
  })
})

describe('sessionToMarkdown', () => {
  it('renders the golden document for a 3-message chat', () => {
    expect(sessionToMarkdown(fixture())).toBe(
      [
        '# Fix the TLS handshake!',
        `_C:/work/argos · ${day(T0)}_`,
        '',
        `## You — ${time(T0)}`,
        '',
        'Why does it fail?',
        '',
        `## Claude — ${time(T0 + 60_000)}`,
        '',
        'Let me look.',
        '',
        '- \u{1F527} Read src/tls.ts',
        '- \u{1F527} TodoWrite',
        '',
        `## You — ${time(T0 + 120_000)}`,
        '',
        'Thanks',
        ''
      ].join('\n')
    )
  })

  it('falls back to "Chat" and spans dates', () => {
    const later = T0 + 2 * 86_400_000
    const md = sessionToMarkdown(
      fixture({ name: '', projectPath: undefined, messages: [
        { role: 'user', content: 'a', timestamp: T0 },
        { role: 'assistant', content: 'b', timestamp: later }
      ] })
    )
    expect(md.startsWith(`# Chat\n_${day(T0)} – ${day(later)}_\n`)).toBe(true)
  })
})

describe('migrateSession', () => {
  it('strips every SDK field and keeps the rest, unknown keys included', () => {
    const legacy = { ...withAllStripped(), someFutureKey: { a: 1 }, unread: true, wslDistro: 'Ubuntu' }
    const out = migrateSession(legacy, '/exports/x.md')
    if ('skip' in out) throw new Error('unexpected skip')
    for (const k of STRIPPED_FIELDS) expect(out.session).not.toHaveProperty(k)
    expect(out.session).not.toHaveProperty('messages')
    expect(out.session).not.toHaveProperty('runbookPath')
    expect(out.session.someFutureKey).toEqual({ a: 1 })
    expect(out.session.unread).toBe(true)
    expect(out.session.wslDistro).toBe('Ubuntu')
    expect(out.session.createdAt).toBe(T0)
    expect(out.session.updatedAt).toBe(T0 + 120_000)
    expect(out.session.provider).toBe('claude')
    expect(out.session.archivedTranscript).toBe('/exports/x.md')
    expect(out.session.hasTerminalActivity).toBe(false)
    expect(out.markdown).toBe(sessionToMarkdown(fixture()))
  })

  it('keeps claudeSessionId for Claude and drops it otherwise', () => {
    const claude = migrateSession(fixture(), 'p')
    const codex = migrateSession(fixture({ model: 'gpt-5.6-sol', codexThreadId: 'th-1' }), 'p')
    const gemini = migrateSession(fixture({ model: 'gemini-3-flash-preview' }), 'p')
    if ('skip' in claude || 'skip' in codex || 'skip' in gemini) throw new Error('unexpected skip')
    expect(claude.session.claudeSessionId).toBe('cc-1')
    expect(codex.session).not.toHaveProperty('claudeSessionId')
    expect(codex.session.provider).toBe('codex')
    expect(codex.session.codexThreadId).toBe('th-1')
    expect(gemini.session).not.toHaveProperty('claudeSessionId')
    expect(gemini.session.provider).toBe('gemini')
  })

  it('skips sessions with no or empty messages', () => {
    expect(migrateSession(fixture({ messages: [] }), 'p')).toEqual({ skip: true })
    const { messages: _m, ...noMessages } = fixture()
    expect(migrateSession(noMessages as LegacySession, 'p')).toEqual({ skip: true })
  })

  it('is idempotent: a migrated session skips', () => {
    const out = migrateSession(fixture(), 'p')
    if ('skip' in out) throw new Error('unexpected skip')
    expect(migrateSession(out.session as unknown as LegacySession, 'p')).toEqual({ skip: true })
  })

  it('does not mutate its input', () => {
    const legacy = fixture()
    migrateSession(legacy, 'p')
    expect(legacy.messages).toHaveLength(3)
    expect(legacy.model).toBe('claude-opus-5')
  })
})

describe('exportFileName', () => {
  it('is date-slug-id.md', () => {
    expect(exportFileName(fixture())).toBe('2026-06-03-fix-the-tls-handshake-abc-123.md')
  })

  it('caps the slug at 40 chars of [a-z0-9-] and handles odd names', () => {
    const name = exportFileName(fixture({ name: 'Ção ' + 'word '.repeat(20) }))
    const slug = name.slice('2026-06-03-'.length, -'-abc-123.md'.length)
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug).toMatch(/^[a-z0-9-]+$/)
    expect(slug.startsWith('cao-word')).toBe(true)
    expect(exportFileName(fixture({ name: '!!!' }))).toBe('2026-06-03-chat-abc-123.md')
  })

  it('uses now when createdAt is missing', () => {
    const now = new Date(2025, 0, 9, 12).getTime()
    expect(exportFileName(fixture({ createdAt: undefined }), now)).toBe('2025-01-09-fix-the-tls-handshake-abc-123.md')
  })
})

describe('upgradeSession', () => {
  const terminalChat = (over: Partial<LegacySession> = {}): LegacySession => {
    const { messages: _m, ...rest } = fixture()
    return { ...rest, hasTerminalActivity: true, permissionMode: 'default', lightMode: false, ...over } as LegacySession
  }

  it('gives a messageless pre-2.0 session a provider and drops the SDK fields', () => {
    const out = upgradeSession(terminalChat({ model: 'gpt-5.6-sol', messages: [] }))
    expect(out).not.toBeNull()
    expect(out!.provider).toBe('codex')
    for (const k of STRIPPED_FIELDS) expect(out).not.toHaveProperty(k)
    expect(out!.hasTerminalActivity).toBe(true)
    expect(out!.projectPath).toBe('C:/work/argos')
    expect(out).not.toHaveProperty('claudeSessionId')
  })

  it('keeps a Claude session id for Claude, and defaults to Claude without a model', () => {
    const { model: _m, ...noModel } = terminalChat()
    const out = upgradeSession(noModel as LegacySession)
    expect(out!.provider).toBe('claude')
    expect(out!.claudeSessionId).toBe('cc-1')
  })

  it('leaves a 2.0 session and a session with messages alone', () => {
    const { messages: _m, model: _model, ...current } = fixture()
    expect(upgradeSession({ ...current, provider: 'gemini' } as LegacySession)).toBeNull()
    expect(upgradeSession(fixture())).toBeNull()
  })

  it('keeps an existing provider over the model', () => {
    expect(upgradeSession(terminalChat({ provider: 'gemini', model: 'claude-opus-5' }))!.provider).toBe('gemini')
  })

  it('is idempotent', () => {
    const once = upgradeSession(terminalChat())!
    expect(upgradeSession(once as LegacySession)).toBeNull()
  })
})
