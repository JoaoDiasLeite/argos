import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '../types'
import { modelForProvider } from './cli-providers'

const m = (id: string, provider: ModelInfo['provider']): ModelInfo => ({
  id,
  label: id,
  inputPrice: 0,
  outputPrice: 0,
  context: '',
  provider
})
const models = [m('claude-opus-4-8', 'claude'), m('claude-haiku-4-5', 'claude'), m('gpt-5', 'codex'), m('gemini-3', 'gemini')]

describe('modelForProvider', () => {
  it('keeps a preferred model that already belongs to the provider', () => {
    expect(modelForProvider(models, 'claude', 'claude-haiku-4-5')).toBe('claude-haiku-4-5')
  })
  it("takes the provider's first model when the preferred one belongs elsewhere", () => {
    expect(modelForProvider(models, 'codex', 'claude-opus-4-8')).toBe('gpt-5')
    expect(modelForProvider(models, 'gemini')).toBe('gemini-3')
  })
  it('falls back to the preferred id when the catalog has nothing for the provider', () => {
    expect(modelForProvider([], 'codex', 'claude-opus-4-8')).toBe('claude-opus-4-8')
  })
})
