/**
 * What the sprint importer asks a forge for, and what it accepts back.
 *
 * Split out because both halves are decisions rather than plumbing. The prompt is the
 * whole contract with the model — the importer has no GitLab or GitHub client of its
 * own, it asks that forge's MCP through the model — and the check on the way back
 * exists because the contract was broken in practice: asked for merge requests against
 * a project whose GitLab API was 500ing, the run quietly returned the issue list
 * instead, which read as the app ignoring the picker. Rows now have to say which kind
 * they are, and the ones that say the wrong thing are dropped and reported.
 *
 * Everything forge-specific is a lookup in `forge-pure.ts`, so adding a forge is a
 * vocabulary change there, not a second importer here.
 */
import { Forge, FORGE_NAMES, changeNoun, refSigil } from './forge-pure'

/** What a backfill run goes looking for. */
export type BackfillKind = 'issues' | 'merge-requests' | 'both'

/** One row as the model hands it back, before anything trusts it. */
export interface BackfillCheckRow {
  title?: string
  notes?: string
  points?: number | null
  kind?: string
  /** `#481`, or `!49` for a GitLab merge request — shown on the sprint card. */
  ref?: string
  /** The issue/MR/PR web URL, so the card can link back to the forge. */
  url?: string
}

// ─── The prompt ───────────────────────────────────────────────────────────────

export function buildBacklogBackfillPrompt(
  instructions?: string,
  kind: BackfillKind = 'issues',
  forge: Forge = 'gitlab'
): string {
  const name = FORGE_NAMES[forge]
  const change = changeNoun(forge)
  const changes = changeNoun(forge, true)
  const issueRef = `${refSigil(forge, 'issue')}<number>`
  const changeRef = `${refSigil(forge, 'merge-request')}<number>`

  const extra = instructions?.trim()
    ? `\n\nAdditional filter / instructions from the user: ${instructions.trim()}`
    : ''

  // "Pending" ones are the open ones — still awaiting review or changes — which is the
  // set worth pulling into a sprint; merged and closed ones are done.
  const wanted =
    kind === 'merge-requests'
      ? `the currently OPEN (pending) ${changes} — anything not yet merged or closed, drafts/WIP included`
      : kind === 'both'
        ? `the currently OPEN issues AND the currently OPEN (pending) ${changes} — anything not yet merged or closed, drafts/WIP included`
        : 'the currently OPEN issues'

  const issueShape = `    { "kind": "issue", "ref": "${issueRef}", "url": "<issue web URL>", "title": "<issue title>", "points": <small integer story-point estimate, or null>, "notes": "<one-line summary, or an empty string>" }`
  const changeShape = `    { "kind": "merge-request", "ref": "${changeRef}", "url": "<${change} web URL>", "title": "<${change} title>", "points": <small integer story-point estimate of the review/finishing work, or null>, "notes": "<the source → target branches, draft or ready, the author, and whether it is awaiting review — or an empty string>" }`
  const bothShape = `    { "kind": "issue" | "merge-request", "ref": "<${issueRef} for an issue, ${changeRef} for a ${change}>", "url": "<web URL>", "title": "<title>", "points": <small integer story-point estimate, or null>, "notes": "<one-line summary; for a ${change} also say source → target, draft or ready, the author, and whether it is awaiting review>" }`

  const shape = kind === 'issues' ? issueShape : kind === 'merge-requests' ? changeShape : bothShape

  const emptyCase =
    kind === 'issues'
      ? 'there are no open issues'
      : kind === 'merge-requests'
        ? `there are no open ${changes}`
        : 'there is nothing open'

  // Without this, a run whose merge/pull-request tool fails falls back to the issue
  // tool and returns issues — the failure the caller sees is "the picker does nothing".
  const changeRule =
    kind === 'issues'
      ? ''
      : `\n\n${change[0].toUpperCase()}${change.slice(1)}s come from the MCP's ${change} tools (list/get ${changes} — NOT the issue tools). ${
          kind === 'merge-requests'
            ? `Return ${changes} ONLY. Do NOT return issues: if the ${change} tools error, time out, or the project has none, return an empty "items" list and say why in "error" — an issue is never an acceptable substitute for a ${change}.`
            : `Issues and ${changes} come from different tools; call both. If one of them fails, return whatever the other gave and say what failed in "error".`
        }`

  // GitHub numbers issues and pull requests in one sequence, so the reference alone
  // cannot say which is which — the model has to state the kind, because nothing
  // downstream can recover it.
  const kindRule =
    forge === 'github'
      ? ' On GitHub issues and pull requests share one numbering sequence, so "kind" is the only thing that tells them apart — never leave it out or infer it from the number.'
      : ''

  return `You have access to this project's configured MCP servers, including a ${name} server. Using ONLY the ${name} MCP tools (and read-only file tools), fetch ${wanted} for this project's ${name} repository so they can seed a sprint backlog. This is strictly READ-ONLY — do NOT create, edit, close, merge, approve, label, or comment on anything.${extra}${changeRule}

Work out the correct ${name} project/repository from: the user's instructions above if they name a project, group or owner, otherwise the git remote in the current directory, otherwise list the repositories available via the MCP and pick the best match. Respond with ONLY a single JSON object — no markdown fences, no prose outside the JSON:
{
  "items": [
${shape}
  ],
  "error": "<one sentence naming the tool that failed, or an empty string>"
}
Every row MUST carry its "kind" and its "ref"; leave "url" as an empty string only if the tools do not give you one.${kindRule} If you cannot reach ${name} or ${emptyCase}, return { "items": [], "error": "<why>" }.`
}

/** The probe run: which repository the MCP is attributed to. */
export function buildProjectProbePrompt(instructions?: string, forge: Forge = 'gitlab'): string {
  const name = FORGE_NAMES[forge]
  const changes = changeNoun(forge, true)
  const extra = instructions?.trim()
    ? `\n\nThe user suggests this project/group: ${instructions.trim()}`
    : ''
  return `You have access to this project's configured MCP servers, including a ${name} server. Load it and determine which single ${name} repository this backlog should be attributed to. Decide it from: the user's suggestion below if given, otherwise the git remote of the repository in the current directory, otherwise the ${name} server's own configured/default repository. This is strictly READ-ONLY — only inspect, do not modify anything.${extra}

Respond with ONLY a single JSON object — no markdown fences, no prose outside the JSON:
{
  "project": "<full path like group/subgroup/name or owner/repo, or best human identifier>",
  "projectId": <numeric project id if the forge has one, or null>,
  "url": "<repository web URL, or empty string>",
  "openIssueCount": <number of open issues if known, or null>,
  "openMrCount": <number of open (pending) ${changes} if known, or null>,
  "source": "git-remote" | "mcp-default" | "instructions" | "guess",
  "note": "<one short sentence explaining how you determined it>"
}
If you cannot determine a repository, return { "project": "", "source": "guess", "note": "<why>" }.`
}

// ─── The check on the way back ────────────────────────────────────────────────

/**
 * Which kind a row really is. The model is asked to state it; where it didn't, a
 * GitLab-style sigil settles it (`!42` is a merge request, `#42` an issue) — first
 * from the `ref` field, then from the notes, which is where older runs put it.
 *
 * On GitHub a `#42` is evidence of nothing, since issues and pull requests share one
 * sequence — so there the fallback only ever answers 'unknown', and an unlabelled row
 * is kept rather than filtered away on a guess.
 */
export function rowKind(
  row: BackfillCheckRow,
  forge: Forge = 'gitlab'
): 'issue' | 'merge-request' | 'unknown' {
  if (row.kind === 'merge-request' || row.kind === 'issue') return row.kind
  const ref = typeof row.ref === 'string' ? row.ref.trim() : ''
  const notes = typeof row.notes === 'string' ? row.notes : ''
  if (ref.startsWith('!') || /![0-9]+/.test(notes)) return 'merge-request'
  if (forge === 'github') return 'unknown'
  if (ref.startsWith('#') || /#[0-9]+/.test(notes)) return 'issue'
  return 'unknown'
}

/** Keep only the rows the caller asked for, and say so when any had to go. */
export function filterBackfillRows(
  raw: unknown,
  kind: BackfillKind,
  forge: Forge = 'gitlab'
): { items: BackfillCheckRow[]; warning?: string } {
  const data = (raw ?? {}) as { items?: unknown; error?: unknown }
  const rows = (Array.isArray(data.items) ? data.items : []).filter(
    (r): r is BackfillCheckRow => !!r && typeof r === 'object'
  )
  const modelError = typeof data.error === 'string' && data.error.trim() ? data.error.trim() : undefined
  // "Both" wants everything, so there is nothing to filter — only the model's own note.
  if (kind === 'both') return { items: rows, warning: modelError }

  const want = kind === 'merge-requests' ? 'merge-request' : 'issue'
  const unwanted = want === 'merge-request' ? 'issue' : 'merge-request'
  const kept = rows.filter((r) => rowKind(r, forge) !== unwanted)
  const dropped = rows.length - kept.length

  const change = changeNoun(forge)
  const wrongKind =
    dropped > 0
      ? `${FORGE_NAMES[forge]} returned ${dropped} ${unwanted === 'issue' ? 'issue' : change}${
          dropped === 1 ? '' : 's'
        } instead of ${want === 'merge-request' ? changeNoun(forge, true) : 'issues'}${
          kept.length > 0 ? ' — those rows were dropped.' : `. The ${change} tools may be failing.`
        }`
      : undefined

  const warning = [modelError, wrongKind].filter(Boolean).join(' ')
  return { items: kept, warning: warning || undefined }
}
