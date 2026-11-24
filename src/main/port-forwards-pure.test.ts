import { describe, it, expect } from 'vitest'
import {
  checkForwards,
  forwardProblemKey,
  forwardTargetChanged,
  ForwardTable,
  isPort,
  listenErrorKind,
  listenOptions,
  usableForwards,
  LISTEN_HOST,
  MAX_FORWARDS,
  type PortForward
} from './port-forwards-pure'
import { PUBLIC_HOST_FIELDS, SECRET_FIELDS, toPublicHost } from './ssh-host-pure'
import { makeT } from '../shared/i18n'
import { resolveHostAuth, stripCredentialAuth } from './ssh-credential-pure'

const fwd = (over: Partial<PortForward> = {}): PortForward => ({
  id: 'f1',
  label: 'db',
  localPort: 15432,
  remoteHost: 'localhost',
  remotePort: 5432,
  ...over
})

describe('isPort', () => {
  it('takes 1..65535 integers, and 0 only when allowed', () => {
    expect(isPort(1)).toBe(true)
    expect(isPort(65535)).toBe(true)
    expect(isPort(0)).toBe(false)
    expect(isPort(0, true)).toBe(true)
    expect(isPort(65536)).toBe(false)
    expect(isPort(-1, true)).toBe(false)
    expect(isPort(22.5)).toBe(false)
    expect(isPort('22')).toBe(false)
    expect(isPort(NaN)).toBe(false)
  })
})

describe('checkForwards', () => {
  it('treats no value as no forwards', () => {
    expect(checkForwards(undefined)).toEqual({ ok: true, forwards: [] })
    expect(checkForwards(null)).toEqual({ ok: true, forwards: [] })
    expect(checkForwards([])).toEqual({ ok: true, forwards: [] })
  })

  it('accepts a valid forward, with localPort 0 for a free port', () => {
    const r = checkForwards([fwd({ localPort: 0, autoStart: true })])
    expect(r).toEqual({ ok: true, forwards: [fwd({ localPort: 0, autoStart: true })] })
  })

  it('defaults an empty remote host to localhost and cleans the label', () => {
    const r = checkForwards([{ ...fwd(), remoteHost: '  ', label: '  painel ​' }])
    expect(r.ok && r.forwards[0]).toMatchObject({ remoteHost: 'localhost', label: 'painel' })
  })

  it('drops autoStart unless it is true', () => {
    const r = checkForwards([{ ...fwd(), autoStart: 'yes' }])
    expect(r.ok && r.forwards[0]).not.toHaveProperty('autoStart')
  })

  it('names the first bad field and its index', () => {
    expect(checkForwards([fwd(), fwd({ id: 'f2', localPort: 70000 })])).toEqual({ ok: false, problem: 'localPort', index: 1 })
    expect(checkForwards([fwd({ remotePort: 0 })])).toEqual({ ok: false, problem: 'remotePort', index: 0 })
    expect(checkForwards([fwd({ remotePort: 65536 })])).toMatchObject({ problem: 'remotePort' })
    expect(checkForwards([fwd({ localPort: -1 })])).toMatchObject({ problem: 'localPort' })
  })

  it('refuses a remote host that isSafeSshHost refuses', () => {
    for (const bad of ['-oProxyCommand=x', 'db host', 'a;b', '$(id)', 'x\ny']) {
      expect(checkForwards([fwd({ remoteHost: bad })]), bad).toMatchObject({ ok: false, problem: 'remoteHost' })
    }
    for (const good of ['10.0.0.5', 'db.internal', '::1', '[fe80::1]']) {
      expect(checkForwards([fwd({ remoteHost: good })]).ok, good).toBe(true)
    }
  })

  it('refuses bad or duplicate ids', () => {
    expect(checkForwards([fwd({ id: '' })])).toMatchObject({ problem: 'id' })
    expect(checkForwards([fwd({ id: 'a/b' })])).toMatchObject({ problem: 'id' })
    expect(checkForwards([fwd(), fwd({ localPort: 0 })])).toEqual({ ok: false, problem: 'id', index: 1 })
    expect(checkForwards(['x'])).toMatchObject({ problem: 'id' })
    expect(checkForwards('x')).toMatchObject({ ok: false })
  })

  it('refuses the same fixed local port twice, but any number of automatic ones', () => {
    expect(checkForwards([fwd(), fwd({ id: 'f2' })])).toEqual({ ok: false, problem: 'duplicateLocalPort', index: 1 })
    expect(checkForwards([fwd({ localPort: 0 }), fwd({ id: 'f2', localPort: 0 })]).ok).toBe(true)
  })

  it('allows at most 20 forwards', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => fwd({ id: `f${i}`, localPort: 0 }))
    expect(checkForwards(many(MAX_FORWARDS)).ok).toBe(true)
    expect(checkForwards(many(MAX_FORWARDS + 1))).toEqual({ ok: false, problem: 'tooMany' })
  })

  it('has a message for every problem in both languages', () => {
    for (const lang of ['en', 'pt-PT'] as const) {
      const t = makeT(lang)
      for (const p of ['tooMany', 'id', 'localPort', 'duplicateLocalPort', 'remoteHost', 'remotePort'] as const) {
        const key = forwardProblemKey(p)
        expect(t(key, { n: 2 }), key).not.toBe(key)
      }
    }
  })
})

describe('usableForwards', () => {
  it('keeps the good ones of a stored list and drops the rest', () => {
    const stored = [fwd(), { id: 'bad', remoteHost: '-x', remotePort: 1, localPort: 0 }, fwd(), 'junk', fwd({ id: 'f3', localPort: 0 })]
    expect(usableForwards(stored).map((f) => f.id)).toEqual(['f1', 'f3'])
    expect(usableForwards(undefined)).toEqual([])
    expect(usableForwards({})).toEqual([])
  })

  it('caps a stored list at 20', () => {
    const many = Array.from({ length: 30 }, (_, i) => fwd({ id: `f${i}`, localPort: 0 }))
    expect(usableForwards(many)).toHaveLength(MAX_FORWARDS)
  })
})

describe('forwards on the host', () => {
  it('are public, not secret, and reach the renderer', () => {
    expect(PUBLIC_HOST_FIELDS).toContain('forwards')
    expect(SECRET_FIELDS as readonly string[]).not.toContain('forwards')
    const pub = toPublicHost({ id: 'h', name: 'n', host: 'h', port: 22, username: 'u', authType: 'agent', forwards: [fwd()] })
    expect(pub.forwards).toEqual([fwd()])
  })

  it('stay with a host linked to a shared credential, which only replaces the login', () => {
    const stored = { ...stripCredentialAuth({ id: 'h', name: 'n', host: 'h', port: 22, username: 'u', authType: 'agent' as const }), credentialId: 'c', forwards: [fwd()] }
    const eff = resolveHostAuth(stored, [{ id: 'c', name: 'ops', username: 'deploy', authType: 'password', password: 'pw' }]).effective
    expect(eff.forwards).toEqual([fwd()])
    expect(toPublicHost(eff).forwards).toEqual([fwd()])
  })
})

describe('loopback only', () => {
  it('always listens on 127.0.0.1, whatever the port', () => {
    expect(LISTEN_HOST).toBe('127.0.0.1')
    for (const port of [0, 1, 5432, 65535]) {
      expect(listenOptions(port)).toEqual({ host: '127.0.0.1', port, exclusive: true })
    }
  })
})

describe('listenErrorKind', () => {
  it('maps the two codes with their own message', () => {
    expect(listenErrorKind('EADDRINUSE')).toBe('inUse')
    expect(listenErrorKind('EACCES')).toBe('denied')
    expect(listenErrorKind('EADDRNOTAVAIL')).toBe('other')
    expect(listenErrorKind(undefined)).toBe('other')
  })
})

describe('forwardTargetChanged', () => {
  it('looks at the ports and remote host, not the label or autoStart', () => {
    expect(forwardTargetChanged(fwd(), fwd({ label: 'x', autoStart: true }))).toBe(false)
    expect(forwardTargetChanged(fwd(), fwd({ localPort: 1 }))).toBe(true)
    expect(forwardTargetChanged(fwd(), fwd({ remoteHost: 'db' }))).toBe(true)
    expect(forwardTargetChanged(fwd(), fwd({ remotePort: 1 }))).toBe(true)
  })
})

describe('ForwardTable', () => {
  const connA = { name: 'a' }
  const connB = { name: 'b' }

  it('claims a start once until it runs or is abandoned', () => {
    const t = new ForwardTable<object>()
    expect(t.begin('h', 'f1')).toBe(true)
    expect(t.begin('h', 'f1')).toBe(false)
    expect(t.isStarting('h', 'f1')).toBe(true)
    t.abandon('h', 'f1')
    expect(t.begin('h', 'f1')).toBe(true)
    t.running('h', fwd(), 40000, connA, 1000)
    expect(t.isStarting('h', 'f1')).toBe(false)
    expect(t.begin('h', 'f1')).toBe(false)
    expect(t.list()).toEqual([{ hostId: 'h', forwardId: 'f1', localPort: 40000, connections: 0, startedAt: 1000, active: true }])
  })

  it('drops a tunnel the user stops', () => {
    const t = new ForwardTable<object>()
    t.running('h', fwd(), 40000, connA)
    expect(t.stop('h', 'f1')).toBe(true)
    expect(t.list()).toEqual([])
    expect(t.stop('h', 'f1')).toBe(false)
  })

  it('keeps a tunnel that stopped on its own, with the reason, until dismissed or restarted', () => {
    const t = new ForwardTable<object>()
    t.running('h', fwd(), 40000, connA)
    t.setConnections('h', 'f1', 2)
    expect(t.stop('h', 'f1', 'closed')).toBe(true)
    expect(t.get('h', 'f1')).toMatchObject({ active: false, error: 'closed', connections: 0 })
    // Stopping again with a reason changes nothing; the first reason stays.
    expect(t.stop('h', 'f1', 'other')).toBe(false)
    expect(t.get('h', 'f1')?.error).toBe('closed')
    expect(t.startedWith('h', 'f1')).toBeUndefined()
    // A stopped one can be started again.
    expect(t.begin('h', 'f1')).toBe(true)
    t.running('h', fwd(), 40001, connB)
    expect(t.get('h', 'f1')).toMatchObject({ active: true, localPort: 40001 })
    expect(t.get('h', 'f1')).not.toHaveProperty('error')
  })

  it('finds the tunnels riding one connection only', () => {
    const t = new ForwardTable<object>()
    t.running('h', fwd(), 1, connA)
    t.running('h', fwd({ id: 'f2' }), 2, connB)
    t.running('g', fwd({ id: 'f3' }), 3, connA)
    expect(t.runningOn(connA)).toEqual([
      { hostId: 'h', forwardId: 'f1' },
      { hostId: 'g', forwardId: 'f3' }
    ])
    expect(t.usesConn(connB)).toBe(true)
    t.stop('h', 'f2', 'gone')
    expect(t.usesConn(connB)).toBe(false)
    expect(t.runningOn(connB)).toEqual([])
    expect(t.ofHost('h').map((s) => s.forwardId)).toEqual(['f1', 'f2'])
  })

  it('reports connection counts and channel errors only for running tunnels, and only on change', () => {
    const t = new ForwardTable<object>()
    expect(t.setConnections('h', 'f1', 1)).toBe(false)
    t.running('h', fwd(), 1, connA)
    expect(t.setConnections('h', 'f1', 1)).toBe(true)
    expect(t.setConnections('h', 'f1', 1)).toBe(false)
    expect(t.setError('h', 'f1', 'refused')).toBe(true)
    expect(t.setError('h', 'f1', 'refused')).toBe(false)
    expect(t.get('h', 'f1')?.error).toBe('refused')
    expect(t.setError('h', 'f1', undefined)).toBe(true)
    expect(t.get('h', 'f1')).not.toHaveProperty('error')
    t.stop('h', 'f1', 'closed')
    expect(t.setError('h', 'f1', 'x')).toBe(false)
    expect(t.setConnections('h', 'f1', 3)).toBe(false)
  })

  it('remembers what a running tunnel was started with', () => {
    const t = new ForwardTable<object>()
    t.running('h', fwd({ remotePort: 80 }), 1, connA)
    expect(t.startedWith('h', 'f1')?.remotePort).toBe(80)
  })
})
