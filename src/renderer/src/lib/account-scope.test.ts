import { describe, it, expect } from 'vitest'
import { acctOf, hasHistory, idFor, isUnstarted, nextChatAfterClose, originOf, provOf, sessionProvider, visibleSessions, AccountDefaults } from './account-scope'
import { ModelInfo, Session } from '../types'

// Minimal model catalog — only the fields provOf reads (id, provider).
const models: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', inputPrice: 0, outputPrice: 0, context: '', provider: 'claude' },
  { id: 'codex-mini', label: 'Codex Mini', inputPrice: 0, outputPrice: 0, context: '', provider: 'codex' },
  { id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro', inputPrice: 0, outputPrice: 0, context: '', provider: 'gemini' }
]

// Minimal Session fixture — only the fields the helpers read. A terminal chat that has
// run by default; a blank draft passes `hasTerminalActivity: false`.
function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    hasTerminalActivity: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('provOf', () => {
  it('resolves a model id to its provider', () => {
    expect(provOf(models, 'claude-opus-4-8')).toBe('claude')
    expect(provOf(models, 'codex-mini')).toBe('codex')
    expect(provOf(models, 'gemini-2-5-pro')).toBe('gemini')
  })

  it('falls back to claude for an unknown/undefined model id', () => {
    expect(provOf(models, undefined)).toBe('claude')
    expect(provOf(models, 'some-unlisted-model')).toBe('claude')
  })
})

describe('sessionProvider', () => {
  it('reads the provider a chat carries', () => {
    expect(sessionProvider({ provider: 'codex' })).toBe('codex')
    expect(sessionProvider({ provider: 'gemini' })).toBe('gemini')
  })

  it('treats a chat with none (a file the migration could not rewrite) as Claude', () => {
    expect(sessionProvider({})).toBe('claude')
  })
})

describe('originOf', () => {
  it('names a WSL chat by its distro, not by the account it was created with', () => {
    // The whole point: this chat HAS an accountId (every session does), and it is
    // irrelevant — the CLI inside the distro runs against the login that lives there.
    const s = makeSession({ id: 'a', accountId: 'work', wslDistro: 'Ubuntu-DevOps' })
    expect(originOf(s)).toEqual({
      key: 'wsl:Ubuntu-DevOps',
      label: 'WSL · Ubuntu-DevOps',
      // The chat list shows this one: there, the distro alone already says "not local",
      // and the four characters of "WSL · " cost the chat's name an ellipsis.
      short: 'Ubuntu-DevOps'
    })
  })

  it('prefers the name the chat was given over one built from the distro', () => {
    const s = makeSession({ id: 'a', wslDistro: 'Ubuntu', remoteHostName: 'WSL · Ubuntu' })
    expect(originOf(s)?.label).toBe('WSL · Ubuntu')
  })

  it('names an SSH chat by its host', () => {
    const s = makeSession({ id: 'a', remoteHostId: 'h1', remoteHostName: 'build-box' })
    expect(originOf(s)).toEqual({ key: 'ssh:h1', label: 'build-box', short: 'build-box' })
  })

  it('falls back to a generic label for a host with no name', () => {
    expect(originOf(makeSession({ id: 'a', remoteHostId: 'h1' }))?.label).toBe('Remote')
  })

  it('gives two distros two different keys, and a local chat none at all', () => {
    expect(originOf(makeSession({ id: 'a', wslDistro: 'Ubuntu' }))?.key).not.toBe(
      originOf(makeSession({ id: 'b', wslDistro: 'Debian' }))?.key
    )
    expect(originOf(makeSession({ id: 'c', accountId: 'work' }))).toBeNull()
  })
})

describe('acctOf', () => {
  const defaults: AccountDefaults = {
    defaultAccountId: 'default',
    codexDefaultAccountId: 'default',
    geminiDefaultAccountId: 'default'
  }

  it('files a legacy Claude chat under the current Claude default account', () => {
    const s = makeSession({ id: 's1', provider: 'claude' })
    expect(acctOf(s, { ...defaults, defaultAccountId: 'claude-work' })).toBe('claude-work')
  })

  it('files a bound Claude chat under its own account regardless of the default', () => {
    const s = makeSession({ id: 's2', provider: 'claude', accountId: 'claude-personal' })
    expect(acctOf(s, { ...defaults, defaultAccountId: 'claude-work' })).toBe('claude-personal')
  })

  it('files a bound Codex chat under its own account', () => {
    const s = makeSession({ id: 's3', provider: 'codex', codexAccountId: 'codex-work' })
    expect(acctOf(s, defaults)).toBe('codex-work')
  })

  it('REGRESSION: an unbound Codex chat falls back to the Codex default account, not the literal "default"', () => {
    const s = makeSession({ id: 's4', provider: 'codex' })
    const withNonDefaultCodex: AccountDefaults = { ...defaults, codexDefaultAccountId: 'codex-work' }
    // The fix: acctOf must resolve to the current Codex default...
    expect(acctOf(s, withNonDefaultCodex)).toBe('codex-work')
    expect(acctOf(s, withNonDefaultCodex)).toBe(withNonDefaultCodex.codexDefaultAccountId)
    // ...whereas the old (buggy) behavior would have returned the literal 'default',
    // which is a different value once a non-default account becomes the Codex default.
    expect(acctOf(s, withNonDefaultCodex)).not.toBe('default')
  })

  it('files an unbound Gemini chat under the Gemini default account', () => {
    const s = makeSession({ id: 's5', provider: 'gemini' })
    expect(acctOf(s, { ...defaults, geminiDefaultAccountId: 'gemini-work' })).toBe('gemini-work')
  })
})

describe('idFor', () => {
  it('uses the selected account when the provider matches the selected provider', () => {
    expect(idFor('claude', 'claude', 'claude-personal', 'default')).toBe('claude-personal')
  })

  it('falls back when the provider is not the one currently selected', () => {
    expect(idFor('codex', 'claude', 'claude-personal', 'codex-default')).toBe('codex-default')
  })

  it('falls back to "default" when neither a selected account nor a fallback is given', () => {
    expect(idFor('claude', 'claude', undefined)).toBe('default')
  })
})

describe('visibleSessions', () => {
  const defaults: AccountDefaults = {
    defaultAccountId: 'claude-work',
    codexDefaultAccountId: 'codex-work',
    geminiDefaultAccountId: 'default'
  }

  const claudeDefaultChat = makeSession({ id: 'c1', provider: 'claude' })
  const claudePersonalChat = makeSession({ id: 'c2', provider: 'claude', accountId: 'claude-personal' })
  const codexBoundChat = makeSession({ id: 'x1', provider: 'codex', codexAccountId: 'codex-side' })
  const codexUnboundChat = makeSession({ id: 'x2', provider: 'codex' })
  const draftChat = makeSession({ id: 'd1', provider: 'claude', hasTerminalActivity: false })
  const allSessions = [claudeDefaultChat, claudePersonalChat, codexBoundChat, codexUnboundChat, draftChat]

  // Runs inside a distro, on a Claude model, carrying an accountId it does not use.
  const wslChat = makeSession({
    id: 'w1',
    provider: 'claude',
    accountId: 'claude-personal',
    wslDistro: 'Ubuntu-DevOps'
  })
  const sshChat = makeSession({ id: 's1', provider: 'claude', remoteHostId: 'h1' })
  const codexWslChat = makeSession({ id: 'w2', provider: 'codex', wslDistro: 'Ubuntu-DevOps' })

  it('1) no active chat: scopes to the selected provider default account, excluding drafts', () => {
    const currentClaudeId = idFor('claude', 'claude', undefined, defaults.defaultAccountId)
    const result = visibleSessions(allSessions, 'claude', currentClaudeId, defaults)
    expect(result.map((s) => s.id)).toEqual(['c1'])
  })

  it('2) active chat on a non-default Claude account: that account is in effect', () => {
    const currentClaudeId = idFor('claude', 'claude', 'claude-personal', defaults.defaultAccountId)
    const result = visibleSessions(allSessions, 'claude', currentClaudeId, defaults)
    expect(result.map((s) => s.id)).toEqual(['c2'])
  })

  it('3) active Codex chat on a non-default account: filed/scoped under that account', () => {
    const currentCodexId = idFor('codex', 'codex', 'codex-side', defaults.codexDefaultAccountId)
    const result = visibleSessions(allSessions, 'codex', currentCodexId, defaults)
    expect(result.map((s) => s.id)).toEqual(['x1'])
  })

  it('files a WSL or SSH chat under the account it was created with', () => {
    // It runs against the distro's own login, but it was started on claude-personal, and
    // showing it on claude-work too leaks one account's chats into the other's list.
    const withOrigins = [...allSessions, wslChat, sshChat]
    const onWork = visibleSessions(withOrigins, 'claude', 'claude-work', defaults)
    const onPersonal = visibleSessions(withOrigins, 'claude', 'claude-personal', defaults)
    expect(onWork.map((s) => s.id)).toEqual(['c1', 's1'])
    expect(onPersonal.map((s) => s.id)).toEqual(['c2', 'w1'])
  })

  it('scopes an origin chat by provider', () => {
    // Where it runs is not which CLI it runs: a Codex account's list is no place for a
    // Claude chat, distro or no distro.
    const withOrigins = [...allSessions, wslChat, codexWslChat]
    const onClaude = visibleSessions(withOrigins, 'claude', 'claude-personal', defaults)
    const onCodex = visibleSessions(withOrigins, 'codex', 'codex-work', defaults)
    expect(onClaude.map((s) => s.id)).toContain('w1')
    expect(onClaude.map((s) => s.id)).not.toContain('w2')
    expect(onCodex.map((s) => s.id)).toContain('w2')
    expect(onCodex.map((s) => s.id)).not.toContain('w1')
  })

  it('keeps an origin draft out of the list like any other draft', () => {
    const draft = makeSession({ id: 'w3', provider: 'claude', wslDistro: 'Ubuntu', hasTerminalActivity: false })
    const result = visibleSessions([...allSessions, draft], 'claude', 'claude-work', defaults)
    expect(result.map((s) => s.id)).not.toContain('w3')
  })

  it('4) unbound legacy Codex chat scopes under the Codex default account (the regression fix)', () => {
    const currentCodexId = idFor('codex', 'codex', undefined, defaults.codexDefaultAccountId)
    expect(currentCodexId).toBe('codex-work')
    const result = visibleSessions(allSessions, 'codex', currentCodexId, defaults)
    expect(result.map((s) => s.id)).toEqual(['x2'])
  })
})

describe('nextChatAfterClose', () => {
  const defaults: AccountDefaults = { defaultAccountId: 'personal' }

  it('stays on the closed chat’s account rather than taking the first chat in the list', () => {
    const closed = makeSession({ id: 'closed', provider: 'claude', accountId: 'work' })
    const other = makeSession({ id: 'other', provider: 'claude', accountId: 'personal' })
    const same = makeSession({ id: 'same', provider: 'claude', accountId: 'work' })
    expect(nextChatAfterClose(closed, [other, same], defaults)?.id).toBe('same')
  })

  it('lands on nothing when no other chat is on that account', () => {
    const closed = makeSession({ id: 'closed', provider: 'claude', accountId: 'work' })
    const other = makeSession({ id: 'other', provider: 'claude', accountId: 'personal' })
    expect(nextChatAfterClose(closed, [other], defaults)).toBeUndefined()
  })

  it('does not cross providers', () => {
    const closed = makeSession({ id: 'closed', provider: 'claude', accountId: 'default' })
    const codex = makeSession({ id: 'codex', provider: 'codex', codexAccountId: 'default' })
    expect(nextChatAfterClose(closed, [codex], {})).toBeUndefined()
  })

  it('skips blank drafts the sidebar does not list', () => {
    const closed = makeSession({ id: 'closed', provider: 'claude', accountId: 'work' })
    const draft = makeSession({ id: 'draft', provider: 'claude', accountId: 'work', hasTerminalActivity: false })
    const terminal = makeSession({ id: 'term', provider: 'claude', accountId: 'work' })
    expect(nextChatAfterClose(closed, [draft, terminal], defaults)?.id).toBe('term')
  })

  it('lands on a WSL chat only when it was created on the same account', () => {
    const wsl = makeSession({ id: 'wsl', provider: 'claude', accountId: 'work', wslDistro: 'Ubuntu' })
    const onWork = makeSession({ id: 'w', provider: 'claude', accountId: 'work' })
    const onPersonal = makeSession({ id: 'p', provider: 'claude', accountId: 'personal' })
    expect(nextChatAfterClose(onWork, [wsl], defaults)?.id).toBe('wsl')
    expect(nextChatAfterClose(onPersonal, [wsl], defaults)).toBeUndefined()
  })
})

describe('isUnstarted', () => {
  it('is a chat with no terminal use, no conversation and no transcript', () => {
    expect(isUnstarted(makeSession({ id: 'd', provider: 'claude', hasTerminalActivity: false }))).toBe(true)
  })

  it('is not a terminal chat — it may be running', () => {
    expect(isUnstarted(makeSession({ id: 't', provider: 'claude' }))).toBe(false)
  })
})

describe('hasHistory', () => {
  const blank = { provider: 'claude' as const, hasTerminalActivity: false }
  it('is false for a blank draft', () => {
    expect(hasHistory(makeSession({ id: 'b', ...blank }))).toBe(false)
  })
  it('counts terminal use', () => {
    expect(hasHistory(makeSession({ id: 't', provider: 'claude' }))).toBe(true)
  })
  it('counts a bound Claude Code conversation that has not run here yet (resumed, or migrated)', () => {
    expect(hasHistory(makeSession({ id: 'c', ...blank, claudeSessionId: 'abc' }))).toBe(true)
  })
  it('counts a pre-2.0 chat the migration exported', () => {
    expect(hasHistory(makeSession({ id: 'o', ...blank, archivedTranscript: 'C:/x/chat.md' }))).toBe(true)
  })
  it('does not count the id a fresh chat reserves for its terminal', () => {
    expect(hasHistory(makeSession({ id: 'p', ...blank, terminalSessionId: 'reserved' }))).toBe(false)
  })
})
