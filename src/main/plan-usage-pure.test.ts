import { describe, expect, it } from 'vitest'
import { carryOverSleeping, tokenAccountKey } from './plan-usage-pure'
import type { AccountPlanUsage } from './plan-usage'

const acct = (key: string, envs: string[], windows = 1): AccountPlanUsage => ({
  accountKey: key,
  accountName: key,
  envs,
  status: 'ok',
  fetchedAt: 1,
  windows: Array.from({ length: windows }, () => ({ key: 'five_hour', label: 's', utilization: 10 }))
})

describe('tokenAccountKey', () => {
  it('is stable and does not contain the token', () => {
    const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz'
    const k = tokenAccountKey(token)
    expect(k).toBe(tokenAccountKey(token))
    expect(k).toMatch(/^tok:[0-9a-f]{16}$/)
    expect(k).not.toContain(token.slice(0, 8))
  })
  it('differs between tokens sharing a prefix', () => {
    const p = 'x'.repeat(30)
    expect(tokenAccountKey(p + 'a')).not.toBe(tokenAccountKey(p + 'b'))
  })
})

describe('carryOverSleeping', () => {
  it('keeps accounts living only in skipped distros, marked stale', () => {
    const out = carryOverSleeping([acct('a', ['Ubuntu'])], [], new Set(['Ubuntu']))
    expect(out).toHaveLength(1)
    expect(out[0].stale).toBe(true)
  })
  it('drops accounts also present locally, or already reported', () => {
    const prev = [acct('a', ['Local', 'Ubuntu']), acct('b', ['Ubuntu'])]
    expect(carryOverSleeping(prev, [acct('b', ['Ubuntu'])], new Set(['Ubuntu']))).toEqual([])
  })
  it('does nothing when no distro was skipped', () => {
    expect(carryOverSleeping([acct('a', ['Ubuntu'])], [], new Set())).toEqual([])
  })
})
