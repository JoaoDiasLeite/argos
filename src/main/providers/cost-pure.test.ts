import { describe, it, expect } from 'vitest'
import { CACHE_READ, CACHE_WRITE_1H, CACHE_WRITE_5M, splitCacheWrite } from './cost-pure'

describe('splitCacheWrite', () => {
  it('reads the TTL split Claude Code actually reports', () => {
    // Measured from a real `claude -p` run: the CLI writes 1h-TTL entries, so the
    // whole cache_creation count lands under ephemeral_1h.
    expect(
      splitCacheWrite({
        cache_creation_input_tokens: 12066,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 12066 }
      })
    ).toEqual({ write5m: 0, write1h: 12066 })
  })

  it('prefers the split over the flat count when both are present', () => {
    // The flat field is kept for back-compat and repeats the total; trusting it
    // would price a 1h write at the 5m rate.
    expect(
      splitCacheWrite({
        cache_creation_input_tokens: 900,
        cache_creation: { ephemeral_5m_input_tokens: 400, ephemeral_1h_input_tokens: 500 }
      })
    ).toEqual({ write5m: 400, write1h: 500 })
  })

  it('treats a legacy flat count as 5m, which is what it was', () => {
    expect(splitCacheWrite({ cache_creation_input_tokens: 7414 })).toEqual({
      write5m: 7414,
      write1h: 0
    })
  })

  it('reports zeros for usage with no cache fields at all', () => {
    expect(splitCacheWrite({ input_tokens: 3 })).toEqual({ write5m: 0, write1h: 0 })
    expect(splitCacheWrite(undefined)).toEqual({ write5m: 0, write1h: 0 })
  })
})

describe('cache multipliers', () => {
  it('prices a 1h write above a 5m one', () => {
    // The regression this guards: 1h writes billed at the 5m rate, understating
    // every cached turn by 37%.
    expect(CACHE_WRITE_1H).toBeGreaterThan(CACHE_WRITE_5M)
    expect(CACHE_WRITE_5M).toBe(1.25)
    expect(CACHE_WRITE_1H).toBe(2)
    expect(CACHE_READ).toBe(0.1)
  })
})
