import { describe, it, expect } from 'vitest'
import { formatContext, mergeCatalog } from './models-catalog-pure'
import { ModelInfo } from './config'

const bundled: ModelInfo[] = [
  { id: 'claude-opus-5', label: 'Opus 5', inputPrice: 5, outputPrice: 25, context: '1M', provider: 'claude' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', inputPrice: 1, outputPrice: 5, context: '200K', provider: 'claude' }
]

describe('formatContext', () => {
  it('renders millions and thousands the way the bundled catalog does', () => {
    expect(formatContext(1_000_000)).toBe('1M')
    expect(formatContext(200_000)).toBe('200K')
    expect(formatContext(272_000)).toBe('272K')
  })

  it('keeps one decimal for sizes that are not round', () => {
    expect(formatContext(1_500_000)).toBe('1.5M')
    expect(formatContext(128_500)).toBe('128.5K')
  })

  it('renders unknown or nonsensical sizes as ?', () => {
    expect(formatContext(undefined)).toBe('?')
    expect(formatContext(0)).toBe('?')
    expect(formatContext(-1)).toBe('?')
    expect(formatContext(NaN)).toBe('?')
  })
})

describe('mergeCatalog', () => {
  it('returns the bundled catalog when there is nothing to merge', () => {
    expect(mergeCatalog(bundled, [], [])).toEqual(bundled)
  })

  it('lets a user override replace a bundled entry by id', () => {
    const override: ModelInfo = { ...bundled[0], label: 'My Opus', inputPrice: 4 }
    const merged = mergeCatalog(bundled, [override], [])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({ id: 'claude-opus-5', label: 'My Opus', inputPrice: 4 })
  })

  it('adds an unknown override id as a new catalogued entry', () => {
    const extra: ModelInfo = {
      id: 'claude-future-9',
      label: 'Future 9',
      inputPrice: 7,
      outputPrice: 35,
      context: '2M',
      provider: 'claude'
    }
    const merged = mergeCatalog(bundled, [extra], [])
    expect(merged).toHaveLength(3)
    expect(merged.find((m) => m.id === 'claude-future-9')).toMatchObject({ inputPrice: 7 })
    expect(merged.find((m) => m.id === 'claude-future-9')?.discovered).toBeUndefined()
  })

  it('adds a discovered model with no pricing, flagged for the picker', () => {
    const merged = mergeCatalog(bundled, [], [
      { id: 'claude-opus-6', provider: 'claude', label: 'Claude Opus 6', maxInputTokens: 1_000_000 }
    ])
    expect(merged.find((m) => m.id === 'claude-opus-6')).toEqual({
      id: 'claude-opus-6',
      label: 'Claude Opus 6',
      inputPrice: 0,
      outputPrice: 0,
      context: '1M',
      provider: 'claude',
      discovered: true
    })
  })

  it('never lets discovery overwrite curated pricing for a known id', () => {
    const merged = mergeCatalog(bundled, [], [
      { id: 'claude-opus-5', provider: 'claude', label: 'Claude Opus 5', maxInputTokens: 1_000_000 }
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual(bundled[0])
  })

  it('falls back to the id as label and ? as context when the source is sparse', () => {
    const merged = mergeCatalog([], [], [{ id: 'gpt-9', provider: 'codex', label: '  ' }])
    expect(merged[0]).toMatchObject({ id: 'gpt-9', label: 'gpt-9', context: '?', provider: 'codex' })
  })

  it('ignores entries with no id and keeps the first sighting of a duplicate', () => {
    const merged = mergeCatalog([], [], [
      { id: '', provider: 'claude' },
      { id: 'dup', provider: 'claude', label: 'First' },
      { id: 'dup', provider: 'claude', label: 'Second' }
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].label).toBe('First')
  })
})
