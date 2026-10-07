import { describe, it, expect } from 'vitest'
import { isSafeRemotePath, parseHistoryLines, SingleFlightCache } from './sftp-pure'

type R = { ok: true; value: string } | { ok: false; error: string }

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('SingleFlightCache', () => {
  it('shares one in-flight open between concurrent callers for the same key', async () => {
    const cache = new SingleFlightCache<R>()
    const d = deferred<R>()
    let opens = 0
    const open = () => {
      opens++
      return d.promise
    }
    const a = cache.get('h1', open)
    const b = cache.get('h1', open)
    const c = cache.get('h1', open)
    d.resolve({ ok: true, value: 'conn' })
    expect(await Promise.all([a, b, c])).toEqual([
      { ok: true, value: 'conn' },
      { ok: true, value: 'conn' },
      { ok: true, value: 'conn' }
    ])
    expect(opens).toBe(1)
  })

  it('reuses a settled success without opening again', async () => {
    const cache = new SingleFlightCache<R>()
    let opens = 0
    const open = async (): Promise<R> => ({ ok: true, value: `conn${++opens}` })
    await cache.get('h1', open)
    expect(await cache.get('h1', open)).toEqual({ ok: true, value: 'conn1' })
    expect(opens).toBe(1)
  })

  it('keeps keys independent', async () => {
    const cache = new SingleFlightCache<R>()
    let opens = 0
    const open = async (): Promise<R> => ({ ok: true, value: `conn${++opens}` })
    await Promise.all([cache.get('h1', open), cache.get('h2', open)])
    expect(opens).toBe(2)
  })

  it('drops a failed open so the next call retries', async () => {
    const cache = new SingleFlightCache<R>()
    let opens = 0
    const open = async (): Promise<R> =>
      ++opens === 1 ? { ok: false, error: 'refused' } : { ok: true, value: 'conn' }
    expect(await cache.get('h1', open)).toEqual({ ok: false, error: 'refused' })
    expect(cache.has('h1')).toBe(false)
    expect(await cache.get('h1', open)).toEqual({ ok: true, value: 'conn' })
    expect(opens).toBe(2)
  })

  it('drops a rejected open and passes the rejection on', async () => {
    const cache = new SingleFlightCache<R>()
    await expect(cache.get('h1', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    expect(cache.has('h1')).toBe(false)
  })

  it('treats a synchronous throw in open as a rejection', async () => {
    const cache = new SingleFlightCache<R>()
    await expect(
      cache.get('h1', () => {
        throw new Error('sync')
      })
    ).rejects.toThrow('sync')
    expect(cache.has('h1')).toBe(false)
  })

  it('evict removes the entry so the next call reconnects', async () => {
    const cache = new SingleFlightCache<R>()
    let evict!: () => void
    let opens = 0
    const open = async (ev: () => void): Promise<R> => {
      evict = ev
      return { ok: true, value: `conn${++opens}` }
    }
    await cache.get('h1', open)
    evict()
    expect(cache.has('h1')).toBe(false)
    expect(await cache.get('h1', open)).toEqual({ ok: true, value: 'conn2' })
  })

  it("a stale entry's evict never removes a newer entry under the same key", async () => {
    const cache = new SingleFlightCache<R>()
    const evicts: Array<() => void> = []
    let opens = 0
    const open = async (ev: () => void): Promise<R> => {
      evicts.push(ev)
      return { ok: true, value: `conn${++opens}` }
    }
    await cache.get('h1', open)
    evicts[0]()
    await cache.get('h1', open)
    evicts[0]() // the old connection's close fires late
    expect(cache.has('h1')).toBe(true)
    expect(await cache.get('h1', open)).toEqual({ ok: true, value: 'conn2' })
  })

  it('take hands back the in-flight entry and frees the key', async () => {
    const cache = new SingleFlightCache<R>()
    const d = deferred<R>()
    const p = cache.get('h1', () => d.promise)
    const taken = cache.take('h1')
    expect(cache.has('h1')).toBe(false)
    d.resolve({ ok: true, value: 'conn' })
    expect(await taken).toEqual({ ok: true, value: 'conn' })
    expect(await p).toEqual({ ok: true, value: 'conn' })
    expect(cache.take('h1')).toBeUndefined()
  })

  it('takeAll empties the cache', async () => {
    const cache = new SingleFlightCache<R>()
    const open = async (): Promise<R> => ({ ok: true, value: 'conn' })
    cache.get('h1', open)
    cache.get('h2', open)
    expect(cache.takeAll()).toHaveLength(2)
    expect(cache.has('h1')).toBe(false)
    expect(cache.has('h2')).toBe(false)
  })
})

describe('isSafeRemotePath', () => {
  it('accepts absolute POSIX paths', () => {
    expect(isSafeRemotePath('/home/user')).toBe(true)
    expect(isSafeRemotePath('/')).toBe(true)
    expect(isSafeRemotePath('/home/user/project/file.txt')).toBe(true)
  })

  it('rejects non-absolute paths', () => {
    expect(isSafeRemotePath('relative/path')).toBe(false)
    expect(isSafeRemotePath('file.txt')).toBe(false)
    expect(isSafeRemotePath('')).toBe(false)
    expect(isSafeRemotePath('~/home')).toBe(false)
  })

  it('rejects paths containing a ".." segment, anywhere', () => {
    expect(isSafeRemotePath('/home/user/..')).toBe(false)
    expect(isSafeRemotePath('/home/../etc/passwd')).toBe(false)
    expect(isSafeRemotePath('/../etc')).toBe(false)
    expect(isSafeRemotePath('/home/user/../../etc')).toBe(false)
  })

  it('rejects non-string input', () => {
    expect(isSafeRemotePath(undefined)).toBe(false)
    expect(isSafeRemotePath(null)).toBe(false)
    expect(isSafeRemotePath(42)).toBe(false)
    expect(isSafeRemotePath({})).toBe(false)
  })
})

describe('parseHistoryLines', () => {
  it('splits raw history text into a command list', () => {
    expect(parseHistoryLines('ls -la\ncd project\ngit status')).toEqual(['ls -la', 'cd project', 'git status'])
  })

  it('strips zsh extended-history timestamp prefixes', () => {
    const raw = ': 1700000000:0;ls -la\n: 1700000005:0;git status'
    expect(parseHistoryLines(raw)).toEqual(['ls -la', 'git status'])
  })

  it('de-dupes only consecutive repeats, not all repeats', () => {
    const raw = 'ls\nls\nls\ncd ..\nls'
    expect(parseHistoryLines(raw)).toEqual(['ls', 'cd ..', 'ls'])
  })

  it('drops blank lines', () => {
    expect(parseHistoryLines('ls\n\n\ncd project\n')).toEqual(['ls', 'cd project'])
  })

  it('caps the result to the most recent N entries, preserving order', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `cmd${i}`).join('\n')
    expect(parseHistoryLines(raw, 3)).toEqual(['cmd7', 'cmd8', 'cmd9'])
  })

  it('handles CRLF line endings', () => {
    expect(parseHistoryLines('ls\r\ncd project\r\n')).toEqual(['ls', 'cd project'])
  })

  it('returns an empty array for empty input', () => {
    expect(parseHistoryLines('')).toEqual([])
  })
})
