import { createHash } from 'crypto'
import type { AccountPlanUsage } from './plan-usage'

/**
 * Identity key for a login whose e-mail is unknown. A short SHA-256 of the token: stable
 * across polls (the same token groups the same login copied between environments) but
 * not reversible, because the key reaches the renderer and the companion's message keys.
 */
export function tokenAccountKey(token: string): string {
  return `tok:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

/**
 * Accounts seen on a previous poll that this one could not look at because every
 * environment they live in is a WSL distro that was stopped. They are returned marked
 * stale, so the UI keeps showing the last number instead of dropping the account.
 * `sleeping` holds the distro names that were skipped.
 */
export function carryOverSleeping(
  previous: AccountPlanUsage[],
  current: AccountPlanUsage[],
  sleeping: ReadonlySet<string>
): AccountPlanUsage[] {
  if (sleeping.size === 0) return []
  const seen = new Set(current.map((a) => a.accountKey))
  return previous
    .filter(
      (a) =>
        !seen.has(a.accountKey) &&
        !!a.envs &&
        a.envs.length > 0 &&
        a.envs.every((e) => sleeping.has(e))
    )
    .map((a) => ({ ...a, stale: a.windows.length > 0 ? true : a.stale }))
}
