import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * runScript's upload over a fake ssh2 connection: a stalled SFTP request must not hang the
 * run, Stop must end it, and whatever was created must be removed (now or at removeUploads).
 */

interface FakeSftp {
  stallWrite: boolean
  failRemovals: boolean
  ops: string[]
  paths: Set<string>
  ended: number
}

const state = vi.hoisted(() => ({ sftps: [] as FakeSftp[], nextStall: [] as boolean[], failRemovals: false, execs: [] as string[] }))

function makeSftp(stallWrite: boolean): FakeSftp & Record<string, unknown> {
  const s: FakeSftp & Record<string, unknown> = {
    stallWrite,
    failRemovals: state.failRemovals,
    ops: [],
    paths: new Set<string>(),
    ended: 0
  }
  const noSuch = (): Error => Object.assign(new Error('No such file'), { code: 2 })
  Object.assign(s, {
    realpath: (_p: string, cb: (e: Error | null, r: string) => void) => cb(null, '/home/ops'),
    mkdir: (d: string, _o: unknown, cb: (e: Error | null) => void) => {
      s.ops.push(`mkdir ${d}`)
      if (s.paths.has(d)) return cb(new Error('exists'))
      s.paths.add(d)
      cb(null)
    },
    stat: (f: string, cb: (e: Error | null, st?: { isDirectory(): boolean }) => void) =>
      s.paths.has(f) ? cb(null, { isDirectory: () => true }) : cb(noSuch()),
    writeFile: (f: string, _d: Buffer, _o: unknown, cb: (e: Error | null) => void) => {
      s.ops.push(`write ${f}`)
      s.paths.add(f)
      if (!s.stallWrite) cb(null) // stalled: the callback never comes
    },
    chmod: (_f: string, _m: number, cb: (e: Error | null) => void) => cb(null),
    unlink: (f: string, cb: (e: Error | null) => void) => {
      s.ops.push(`unlink ${f}`)
      if (s.failRemovals) return cb(new Error('Permission denied'))
      cb(remote.paths.delete(f) ? null : noSuch())
    },
    rmdir: (d: string, cb: (e: Error | null) => void) => {
      s.ops.push(`rmdir ${d}`)
      if (s.failRemovals) return cb(new Error('Permission denied'))
      if ([...remote.paths].some((x) => x.startsWith(`${d}/`))) return cb(new Error('Failure'))
      cb(remote.paths.delete(d) ? null : noSuch())
    },
    end: () => {
      s.ended++
    }
  })
  return s
}

// One remote file system shared by every channel, as on a real host.
const remote = { paths: new Set<string>() }

vi.mock('./sftp', () => ({
  getRemoteClient: async () => ({
    ok: true,
    conn: {
      sftp: (cb: (e: Error | null, s: unknown) => void) => {
        const s = makeSftp(state.nextStall.shift() ?? false)
        // Writes land on the shared host.
        s.paths = remote.paths
        state.sftps.push(s)
        cb(null, s)
      },
      exec: (cmd: string, _o: unknown, cb: (e: Error | null, ch: unknown) => void) => {
        state.execs.push(cmd)
        const handlers: Record<string, ((...a: unknown[]) => void)[]> = {}
        const ch = {
          on: (ev: string, f: (...a: unknown[]) => void) => ((handlers[ev] ??= []).push(f), ch),
          stderr: { on: () => undefined },
          end: () => {
            setTimeout(() => {
              for (const f of handlers.exit ?? []) f(0)
              for (const f of handlers.close ?? []) f()
            }, 0)
          },
          signal: () => undefined,
          close: () => undefined
        }
        cb(null, ch)
      },
      on: () => undefined,
      removeListener: () => undefined
    }
  }),
  sftpList: async () => ({ ok: false }),
  sftpRead: async () => ({ ok: false })
}))
vi.mock('./ssh', () => ({ testConnection: async () => ({ ok: true, message: '' }) }))
vi.mock('./i18n', () => ({ t: (k: string) => k }))

const { createSshBackend } = await import('./ops-exec')

const opts = (signal = new AbortController().signal) => ({ timeoutMs: 5000, maxOutputBytes: 1000, signal })

beforeEach(() => {
  state.sftps = []
  state.nextStall = []
  state.failRemovals = false
  state.execs = []
  remote.paths.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runScript upload', () => {
  it('uploads, runs, then removes the file, its folder and the empty ~/.argos-ops', async () => {
    const backend = createSshBackend()
    const hooks = { removed: vi.fn(async () => undefined) }
    const r = await backend.runScript('h1', 'check.sh', Buffer.from('#!/bin/sh\n'), [], opts(), hooks)
    expect(r.ok).toBe(true)
    expect(state.execs).toHaveLength(1)
    expect(state.execs[0]).toMatch(/^'?\/home\/ops\/\.argos-ops\/[0-9a-f]{16}\/check\.sh'?$/)
    expect([...remote.paths]).toEqual([])
    expect(hooks.removed).toHaveBeenCalledOnce()
    expect(state.sftps[0].ops.at(-1)).toBe('rmdir /home/ops/.argos-ops')
  })

  it('leaves ~/.argos-ops when something else is in it', async () => {
    remote.paths.add('/home/ops/.argos-ops')
    remote.paths.add('/home/ops/.argos-ops/other')
    const backend = createSshBackend()
    await backend.runScript('h1', 'check.sh', Buffer.from('x'), [], opts())
    expect([...remote.paths].sort()).toEqual(['/home/ops/.argos-ops', '/home/ops/.argos-ops/other'])
  })

  it('Stop ends a stalled upload, never runs the script, and cleans up on a fresh channel', async () => {
    state.nextStall = [true]
    const backend = createSshBackend()
    const ctl = new AbortController()
    const hooks = { uploaded: vi.fn(async () => undefined), removed: vi.fn(async () => undefined) }
    const running = backend.runScript('h1', 'check.sh', Buffer.from('x'), [], opts(ctl.signal), hooks)
    await new Promise((r) => setTimeout(r, 10))
    ctl.abort()
    const r = await running
    expect(r).toMatchObject({ ok: false, error: 'aborted while uploading the script' })
    expect(state.execs).toEqual([])
    expect(hooks.uploaded).not.toHaveBeenCalled()
    // The stalled channel was ended; a second one removed the half-written upload.
    expect(state.sftps[0].ended).toBeGreaterThan(0)
    expect(state.sftps).toHaveLength(2)
    expect([...remote.paths]).toEqual([])
    expect(hooks.removed).not.toHaveBeenCalled()
  })

  it('a stalled upload times out instead of hanging the run', async () => {
    vi.useFakeTimers()
    state.nextStall = [true]
    const backend = createSshBackend()
    const running = backend.runScript('h1', 'check.sh', Buffer.from('x'), [], opts())
    await vi.advanceTimersByTimeAsync(31_000)
    const r = await running
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/^timed out after 30s while uploading the script$/)
    expect(state.execs).toEqual([])
    expect([...remote.paths]).toEqual([])
  })

  it('what cannot be removed now is retried by removeUploads, and only that', async () => {
    state.failRemovals = true
    const backend = createSshBackend()
    await backend.runScript('h1', 'check.sh', Buffer.from('x'), [], opts())
    const left = [...remote.paths].find((p) => p.endsWith('/check.sh'))
    expect(left).toBeDefined()

    state.failRemovals = false
    expect(await backend.removeUploads('h2')).toEqual({ removed: [], left: [] })
    expect(await backend.removeUploads('h1')).toEqual({ removed: [left], left: [] })
    expect([...remote.paths]).toEqual([])
    // Nothing left to do the second time, so no connection is opened.
    const channels = state.sftps.length
    expect(await backend.removeUploads('h1')).toEqual({ removed: [], left: [] })
    expect(state.sftps).toHaveLength(channels)
  })
})
