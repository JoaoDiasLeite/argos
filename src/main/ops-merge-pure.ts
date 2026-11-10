/**
 * "Somar à base": a runbook from the runbooks folder added to the base intervention
 * shipped with Argos (docs/BASE_INTERVENTION_PLAN.md §5). Pure: both runbooks come in
 * already loaded and validated, and one LoadedRunbook comes out for the session, so the
 * gate, the executor and the ledger keep seeing a single runbook.
 *
 * The runbook is what the operator chose, so it names the run and its host groups: the
 * base's rules apply exactly on the hosts the runbook covers, never beyond them.
 */
import type { LoadedRunbook } from './ops-runbook-pure'
import type { OpsApproval, OpsPolicy } from './ops-types'
import type { TFunction } from '../shared/i18n'

const union = (a: string[] = [], b: string[] = []): string[] => [...new Set([...a, ...b])]

function pick(a: number | undefined, b: number | undefined, f: (x: number, y: number) => number): number | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return f(a, b)
}

/**
 * - `allow`: the runbook's rules first (its titles win on a tie), then the base's, moved
 *   onto every host group of the runbook.
 * - `scripts`: the runbook's, then the base's whose name the runbook does not use; a
 *   runbook script with a base script's name replaces it (`replacedScripts`).
 * - `read.paths` and `read.deny` unioned (a deny on either side still wins over every
 *   path); `write` is the runbook's, joined with the base's if the base ever has one.
 * - `limits`: the longer timeout and the larger output, the smaller concurrency.
 * - always `strict`: an unmatched call is denied even when the runbook alone would ask.
 */
export function mergePolicies(base: OpsPolicy, runbook: OpsPolicy): { policy: OpsPolicy; replacedScripts: string[] } {
  const groups = Object.keys(runbook.hosts)
  const ownScripts = new Set(runbook.scripts.map((s) => s.name))
  const replacedScripts = base.scripts.filter((s) => ownScripts.has(s.name)).map((s) => s.name)

  const policy: OpsPolicy = {
    version: 1,
    strict: true,
    ...((runbook.platform ?? base.platform) ? { platform: runbook.platform ?? base.platform } : {}),
    hosts: structuredClone(runbook.hosts),
    allow: [...structuredClone(runbook.allow), ...base.allow.map((r) => ({ ...structuredClone(r), hosts: [...groups] }))],
    scripts: [
      ...structuredClone(runbook.scripts),
      ...base.scripts.filter((s) => !ownScripts.has(s.name)).map((s) => ({ ...structuredClone(s), hosts: [...groups] }))
    ]
  }

  if (base.read || runbook.read) {
    const deny = union(base.read?.deny, runbook.read?.deny)
    const maxBytes = pick(base.read?.maxBytes, runbook.read?.maxBytes, Math.max)
    policy.read = {
      paths: union(runbook.read?.paths, base.read?.paths),
      ...(deny.length ? { deny } : {}),
      ...(maxBytes !== undefined ? { maxBytes } : {})
    }
  }

  if (base.write || runbook.write) {
    const approvals = [base.write?.approval, runbook.write?.approval].filter((a): a is OpsApproval => !!a)
    const backup = base.write?.backup || runbook.write?.backup
    policy.write = {
      paths: union(runbook.write?.paths, base.write?.paths),
      ...(approvals.length ? { approval: approvals.includes('ask') ? 'ask' : approvals[0] } : {}),
      ...(backup !== undefined ? { backup } : {})
    }
  }

  if (base.limits || runbook.limits) {
    const timeoutMs = pick(base.limits?.timeoutMs, runbook.limits?.timeoutMs, Math.max)
    const maxOutputBytes = pick(base.limits?.maxOutputBytes, runbook.limits?.maxOutputBytes, Math.max)
    const concurrentPerHost = pick(base.limits?.concurrentPerHost, runbook.limits?.concurrentPerHost, Math.min)
    policy.limits = {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(concurrentPerHost !== undefined ? { concurrentPerHost } : {})
    }
  }

  return { policy, replacedScripts }
}

/**
 * One runbook for the session: the runbook's name, path and host groups, the merged
 * policy, the base's guidelines followed by the runbook's, and each script's own folder.
 * `ref.base` records the base's hashes beside the runbook's, so the ledger's run.start
 * names both policies.
 */
export function mergeRunbooks(base: LoadedRunbook, runbook: LoadedRunbook, t: TFunction): LoadedRunbook {
  const { policy, replacedScripts } = mergePolicies(base.policy, runbook.policy)

  const scriptDirs: Record<string, string> = {}
  for (const s of policy.scripts) {
    const own = runbook.policy.scripts.some((r) => r.name === s.name)
    const from = own ? runbook : base
    scriptDirs[s.name] = from.scriptDirs?.[s.name] ?? from.scriptsDir
  }

  const guidelines = [
    base.guidelines.trimEnd(),
    `## ${t('runbook.merge.heading', { name: runbook.ref.name })}`,
    t('runbook.merge.intro'),
    runbook.guidelines.trim()
  ].join('\n\n') + '\n'

  return {
    ref: {
      ...runbook.ref,
      ...(policy.platform ? { platform: policy.platform } : {}),
      base: {
        name: base.ref.name,
        path: base.ref.path,
        policySha256: base.ref.policySha256,
        runbookMdSha256: base.ref.runbookMdSha256
      }
    },
    policy,
    guidelines,
    scriptsDir: runbook.scriptsDir,
    scriptDirs,
    warnings: [...runbook.warnings, ...replacedScripts.map((name) => t('runbook.merge.scriptReplaced', { name }))],
    hosts: runbook.hosts
  }
}

/** The folder a script is read from, for a plain or a merged runbook alike. */
export function scriptDir(runbook: LoadedRunbook, name: string): string {
  return runbook.scriptDirs?.[name] ?? runbook.scriptsDir
}

/** For tests and the start screen: whether a loaded runbook is a merge. */
export const isMerged = (runbook: LoadedRunbook): boolean => !!runbook.ref.base
