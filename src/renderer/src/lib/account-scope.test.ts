import { describe, it, expect } from 'vitest'
import { acctOf, idFor, originOf, provOf, visibleSessions, AccountDefaults } from './account-scope'
import { ModelInfo, Session } from '../types'

// Minimal model catalog — only the fields provOf reads (id, provider).
const models: ModelInfo[] = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', inputPrice: 0, outputPrice: 0, context: '', provider: 'claude' },
  { id: 'codex-mini', label: 'Codex Mini', inputPrice: 0, outputPrice: 0, context: '', provider: 'codex' },
  { id: 'gemini-2-5-pro', label: 'Gemini 2.5 Pro', inputPrice: 0, outputPrice: 0, context: '', provider: 'gemini' }
]

// Minimal Session fixture — only the fields the helpers read.
function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    messages: overrides.messages ?? [{ id: 'm1', role: 'user', content: 'hi', timestamp: 0 }],
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
    const s = makeSession({ id: 's1', model: 'claude-opus-4-8' })
    expect(acctOf(s, models, { ...defaults, defaultAccountId: 'claude-work' })).toBe('claude-work')
  })

  it('files a bound Claude chat under its own account regardless of the default', () => {
    const s = makeSession({ id: 's2', model: 'claude-opus-4-8', accountId: 'claude-personal' })
    expect(acctOf(s, models, { ...defaults, defaultAccountId: 'claude-work' })).toBe('claude-personal')
  })

  it('files a bound Codex chat under its own account', () => {
    const s = makeSession({ id: 's3', model: 'codex-mini', codexAccountId: 'codex-work' })
    expect(acctOf(s, models, defaults)).toBe('codex-work')
  })

  it('REGRESSION: an unbound Codex chat falls back to the Codex default account, not the literal "default"', () => {
    const s = makeSession({ id: 's4', model: 'codex-mini' })
    const withNonDefaultCodex: AccountDefaults = { ...defaults, codexDefaultAccountId: 'codex-work' }
    // The fix: acctOf must resolve to the current Codex default...
    expect(acctOf(s, models, withNonDefaultCodex)).toBe('codex-work')
    expect(acctOf(s, models, withNonDefaultCodex)).toBe(withNonDefaultCodex.codexDefaultAccountId)
    // ...whereas the old (buggy) behavior would have returned the literal 'default',
    // which is a different value once a non-default account becomes the Codex default.
    expect(acctOf(s, models, withNonDefaultCodex)).not.toBe('default')
  })

  it('files an unbound Gemini chat under the Gemini default account', () => {
    const s = makeSession({ id: 's5', model: 'gemini-2-5-pro' })
    expect(acctOf(s, models, { ...defaults, geminiDefaultAccountId: 'gemini-work' })).toBe('gemini-work')
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

  const claudeDefaultChat = makeSession({ id: 'c1', model: 'claude-opus-4-8' })
  const claudePersonalChat = makeSession({ id: 'c2', model: 'claude-opus-4-8', accountId: 'claude-personal' })
  const codexBoundChat = makeSession({ id: 'x1', model: 'codex-mini', codexAccountId: 'codex-side' })
  const codexUnboundChat = makeSession({ id: 'x2', model: 'codex-mini' })
  const draftChat = makeSession({ id: 'd1', model: 'claude-opus-4-8', messages: [] })
  const allSessions = [claudeDefaultChat, claudePersonalChat, codexBoundChat, codexUnboundChat, draftChat]

  // Runs inside a distro, on a Claude model, carrying an accountId it does not use.
  const wslChat = makeSession({
    id: 'w1',
    model: 'claude-opus-4-8',
    accountId: 'claude-personal',
    wslDistro: 'Ubuntu-DevOps'
  })
  const sshChat = makeSession({ id: 's1', model: 'claude-opus-4-8', remoteHostId: 'h1' })
  const codexWslChat = makeSession({ id: 'w2', model: 'codex-mini', wslDistro: 'Ubuntu-DevOps' })

  it('1) no active chat: scopes to the selected provider default account, excluding drafts', () => {
    const currentClaudeId = idFor('claude', 'claude', undefined, defaults.defaultAccountId)
    const result = visibleSessions(allSessions, models, 'claude', currentClaudeId, defaults)
    expect(result.map((s) => s.id)).toEqual(['c1'])
  })

  it('2) active chat on a non-default Claude account: that account is in effect', () => {
    const currentClaudeId = idFor('claude', 'claude', 'claude-personal', defaults.defaultAccountId)
    const result = visibleSessions(allSessions, models, 'claude', currentClaudeId, defaults)
    expect(result.map((s) => s.id)).toEqual(['c2'])
  })

  it('3) active Codex chat on a non-default account: filed/scoped under that account', () => {
    const currentCodexId = idFor('codex', 'codex', 'codex-side', defaults.codexDefaultAccountId)
    const result = visibleSessions(allSessions, models, 'codex', currentCodexId, defaults)
    expect(result.map((s) => s.id)).toEqual(['x1'])
  })

  it('shows a WSL chat whichever account is selected', () => {
    // It carries claude-personal and runs on neither that nor claude-work. Filing it under
    // an account would only pick which list it disappears from; the row says 'Ubuntu-DevOps'
    // either way, so there is nothing to confuse it with.
    const withOrigins = [...allSessions, wslChat, sshChat]
    const onWork = visibleSessions(withOrigins, models, 'claude', 'claude-work', defaults)
    const onPersonal = visibleSessions(withOrigins, models, 'claude', 'claude-personal', defaults)
    expect(onWork.map((s) => s.id)).toEqual(['c1', 'w1', 's1'])
    expect(onPersonal.map((s) => s.id)).toEqual(['c2', 'w1', 's1'])
  })

  it('still scopes an origin chat by provider', () => {
    // Where it runs is not which CLI it runs: a Codex account's list is no place for a
    // Claude chat, distro or no distro.
    const withOrigins = [...allSessions, wslChat, codexWslChat]
    const onClaude = visibleSessions(withOrigins, models, 'claude', 'claude-work', defaults)
    const onCodex = visibleSessions(withOrigins, models, 'codex', 'codex-work', defaults)
    expect(onClaude.map((s) => s.id)).toContain('w1')
    expect(onClaude.map((s) => s.id)).not.toContain('w2')
    expect(onCodex.map((s) => s.id)).toContain('w2')
    expect(onCodex.map((s) => s.id)).not.toContain('w1')
  })

  it('keeps an origin draft out of the list like any other draft', () => {
    const draft = makeSession({ id: 'w3', model: 'claude-opus-4-8', wslDistro: 'Ubuntu', messages: [] })
    const result = visibleSessions([...allSessions, draft], models, 'claude', 'claude-work', defaults)
    expect(result.map((s) => s.id)).not.toContain('w3')
  })

  it('4) unbound legacy Codex chat scopes under the Codex default account (the regression fix)', () => {
    const currentCodexId = idFor('codex', 'codex', undefined, defaults.codexDefaultAccountId)
    expect(currentCodexId).toBe('codex-work')
    const result = visibleSessions(allSessions, models, 'codex', currentCodexId, defaults)
    expect(result.map((s) => s.id)).toEqual(['x2'])
  })
})
