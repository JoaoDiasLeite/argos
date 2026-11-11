import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDebouncedSaver } from './debounced-saver'

describe('createDebouncedSaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('saves only the latest payload after the delay', () => {
    const save = vi.fn()
    const s = createDebouncedSaver<number>({ delay: 100, save })
    s.schedule('a', 1)
    s.schedule('a', 2)
    vi.advanceTimersByTime(99)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save.mock.calls).toEqual([[2]])
  })

  it('keeps one pending save per key', () => {
    const save = vi.fn()
    const s = createDebouncedSaver<string>({ delay: 100, save })
    s.schedule('a', 'A')
    s.schedule('b', 'B')
    vi.advanceTimersByTime(100)
    expect(save.mock.calls.map((c) => c[0]).sort()).toEqual(['A', 'B'])
  })

  it('flushAll runs pending saves immediately and not twice', () => {
    const save = vi.fn()
    const s = createDebouncedSaver<string>({ delay: 100, save })
    s.schedule('a', 'A')
    s.schedule('b', 'B')
    s.flushAll()
    expect(save).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(500)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('discard drops a pending save', () => {
    const save = vi.fn()
    const s = createDebouncedSaver<string>({ delay: 100, save })
    s.schedule('a', 'A')
    s.discard('a')
    vi.advanceTimersByTime(500)
    expect(save).not.toHaveBeenCalled()
  })

  it('reports rejected and thrown saves, then success', async () => {
    const results: unknown[] = []
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('disk'))
      .mockImplementationOnce(() => {
        throw new Error('sync')
      })
      .mockResolvedValueOnce(undefined)
    const s = createDebouncedSaver<number>({ delay: 10, save, onResult: (e) => results.push(e) })
    s.schedule('a', 1)
    s.flush('a')
    s.schedule('a', 2)
    s.flush('a')
    s.schedule('a', 3)
    s.flush('a')
    await Promise.resolve()
    await Promise.resolve()
    expect(results.map((e) => (e ? (e as Error).message : null))).toEqual(['sync', 'disk', null])
  })
})
