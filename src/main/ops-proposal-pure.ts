/**
 * "Add to Argos" (docs/BASE_INTERVENTION_PLAN.md §6): after a run with a runbook of the
 * operator's, what that runbook allows that the base intervention does not, as a GitHub
 * issue on the Argos repo proposing it for the base. Pure: main hands in the two policies,
 * the rules the run matched and the stored hosts, and opens the URL itself.
 *
 * The Argos repo is public, so the issue carries policy shapes and nothing about where they
 * ran: no host group contents, no server, client, ticket or task, no RUNBOOK.md, no command
 * output. Any stored host's name or address that a rule happens to spell out is replaced.
 */
import type { OpsAllowRule, OpsPolicy, OpsScriptRule } from './ops-types'

export const ARGOS_ISSUES_URL = 'https://github.com/JoaoDiasLeite/argos/issues/new'
/** Past this, the body goes to the clipboard and the URL carries only a pointer to it. */
export const ISSUE_URL_MAX = 7000

export interface BaseProposalInput {
  base: OpsPolicy
  runbook: OpsPolicy
  runbookName: string
  /** The gate's matched rule ids in the run: an allow rule's cmd source, `script:<name>`. */
  usedRules: string[]
  outcome: 'ok' | 'failed' | 'aborted'
  argosVersion: string
  /** Stored hosts' names and addresses: never spelled out in the issue. */
  hostWords: string[]
}

export interface BaseProposal {
  rules: (Omit<OpsAllowRule, 'hosts'> & { used: boolean })[]
  scripts: (Omit<OpsScriptRule, 'hosts'> & { used: boolean })[]
  readPaths: string[]
  readDeny: string[]
  writePaths: string[]
  title: string
  body: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Every stored host's name and address, and their regex-escaped spelling, become <host>. */
function scrubber(words: string[]): (s: string) => string {
  const list = [...new Set(words.map((w) => w.trim()).filter((w) => w.length >= 3))].sort((a, b) => b.length - a.length)
  if (list.length === 0) return (s) => s
  const re = new RegExp(list.flatMap((w) => [escapeRe(escapeRe(w)), escapeRe(w)]).join('|'), 'gi')
  return (s) => s.replace(re, '<host>')
}

/**
 * What the runbook adds to the base, or null when it adds nothing (then there is nothing
 * to propose and Argos does not ask).
 */
export function baseProposal(input: BaseProposalInput): BaseProposal | null {
  const scrub = scrubber(input.hostWords)
  const baseCmds = new Set(input.base.allow.map((r) => r.cmd))
  const baseScripts = new Set(input.base.scripts.map((s) => `${s.name}\u0000${s.sha256}`))
  const used = new Set(input.usedRules)

  const rules = input.runbook.allow
    .filter((r) => !baseCmds.has(r.cmd))
    .map(({ hosts: _hosts, ...r }) => ({
      ...r,
      cmd: scrub(r.cmd),
      ...(r.title ? { title: scrub(r.title) } : {}),
      used: used.has(r.cmd)
    }))
  const scripts = input.runbook.scripts
    .filter((s) => !baseScripts.has(`${s.name}\u0000${s.sha256}`))
    .map(({ hosts: _hosts, ...s }) => ({
      ...s,
      ...(s.title ? { title: scrub(s.title) } : {}),
      ...(s.args?.pattern ? { args: { ...s.args, pattern: scrub(s.args.pattern) } } : {}),
      used: used.has(`script:${s.name}`)
    }))
  const notIn = (list: string[] = [], base: string[] = []) => list.filter((p) => !base.includes(p)).map(scrub)
  const readPaths = notIn(input.runbook.read?.paths, input.base.read?.paths)
  const readDeny = notIn(input.runbook.read?.deny, input.base.read?.deny)
  const writePaths = notIn(input.runbook.write?.paths, input.base.write?.paths)

  if (rules.length + scripts.length + readPaths.length + writePaths.length === 0) return null

  const name = scrub(input.runbookName)
  const title = `runbook: add ${name} to the base intervention`
  const usedCount = rules.filter((r) => r.used).length + scripts.filter((s) => s.used).length
  const json = (v: unknown) => '```json\n' + JSON.stringify(v, null, 2) + '\n```'
  const body = [
    `Proposed from Argos ${input.argosVersion} after a run with the runbook \`${name}\` (outcome: ${input.outcome}).`,
    `It allows ${rules.length} rule(s) and ${scripts.length} script(s) the base intervention does not; ${usedCount} of them were used in the run.`,
    'Host groups, servers and the run itself are left out on purpose: the base applies on every server.',
    '',
    '## Rules',
    rules.length ? json(rules) : '_None._',
    '',
    '## Scripts',
    scripts.length
      ? json(scripts) + '\n\nOnly names and hashes: the scripts themselves live in the runbook folder (wm-devsecops `runbooks/argos/`).'
      : '_None._',
    ...(readPaths.length || readDeny.length || writePaths.length
      ? ['', '## Paths', json({ readPaths, readDeny, writePaths })]
      : []),
    '',
    '## To decide',
    '- [ ] Which of these belong in every intervention (`resources/runbooks/diagnosis` for reads, `scripts/intervention` for changes).',
    '- [ ] Titles in pt-PT for the client report.',
    '- [ ] Tests in `ops-despiste-runbook.test.ts` / `ops-intervention-runbook.test.ts`, both directions.'
  ].join('\n')

  return { rules, scripts, readPaths, readDeny, writePaths, title, body }
}

/**
 * The new-issue URL. A body that would make it too long is left out: the caller copies it
 * to the clipboard and the URL says so.
 */
export function issueUrl(p: Pick<BaseProposal, 'title' | 'body'>, clipboardNote: string): { url: string; viaClipboard: boolean } {
  const full = `${ARGOS_ISSUES_URL}?title=${encodeURIComponent(p.title)}&body=${encodeURIComponent(p.body)}`
  if (full.length <= ISSUE_URL_MAX) return { url: full, viaClipboard: false }
  return { url: `${ARGOS_ISSUES_URL}?title=${encodeURIComponent(p.title)}&body=${encodeURIComponent(clipboardNote)}`, viaClipboard: true }
}
