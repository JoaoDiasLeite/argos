import { describe, it, expect } from 'vitest'
import { acctOf, idFor, provOf, visibleSessions, AccountDefaults } from './account-scope'
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

  it('4) unbound legacy Codex chat scopes under the Codex default account (the regression fix)', () => {
    const currentCodexId = idFor('codex', 'codex', undefined, defaults.codexDefaultAccountId)
    expect(currentCodexId).toBe('codex-work')
    const result = visibleSessions(allSessions, models, 'codex', currentCodexId, defaults)
    expect(result.map((s) => s.id)).toEqual(['x2'])
  })
})
