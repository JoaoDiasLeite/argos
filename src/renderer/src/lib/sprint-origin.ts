/**
 * Where a sprint item came from, when it came from a forge.
 *
 * Imported items carry their reference, kind and forge as fields, but the ones
 * imported before those fields existed only have the reference buried in the notes
 * ("#481 — Port the workflow listing…"). Rather than migrate the stored sprints, it
 * is read back out of the notes when the field is absent — the importer has always
 * written it in the same shape, and an item typed by hand simply has no origin.
 *
 * The forge matters because the two disagree about references: on GitLab `#481` and
 * `!49` are separate namespaces, so the sigil identifies the kind; on GitHub issues
 * and pull requests share one sequence and both read `#49`, so only the stored kind
 * knows. Anything imported before the forge field existed is GitLab — nothing else
 * could have written it.
 */

export type Forge = 'gitlab' | 'github'
export type OriginKind = 'issue' | 'merge-request'

export interface SprintOrigin {
  /** The reference as its forge writes it: `#481`, or `!49` for a GitLab MR. */
  ref: string
  kind: OriginKind
  forge: Forge
}

/** The nouns each forge uses — mirrors `main/forge-pure.ts`, which the renderer
 *  cannot import across the process boundary. */
export const FORGE_NAMES: Record<Forge, string> = { gitlab: 'GitLab', github: 'GitHub' }

export function kindLabel(forge: Forge, kind: OriginKind): string {
  if (kind === 'issue') return 'Issue'
  return forge === 'github' ? 'Pull request' : 'Merge request'
}

/**
 * A reference at the start of the notes, or anywhere in them preceded by whitespace.
 * Anchored this way so a `#` inside prose doesn't invent an origin ("C#9" and
 * "rgb(#481)" are not references).
 */
const REF_RE = /(^|\s)([#!])(\d+)\b/

export function originOf(item: {
  ref?: string | null
  kind?: string | null
  forge?: string | null
  notes?: string | null
}): SprintOrigin | null {
  // Items stored before the forge field existed can only have come from GitLab.
  const forge: Forge = item.forge === 'github' ? 'github' : 'gitlab'
  const explicitKind: OriginKind | null =
    item.kind === 'issue' || item.kind === 'merge-request' ? item.kind : null

  const ref = item.ref?.trim()
  if (ref) {
    // On GitHub the sigil says nothing, so only an explicit kind can place the row.
    const sigil: OriginKind | null =
      forge === 'gitlab' && ref.startsWith('!')
        ? 'merge-request'
        : forge === 'gitlab' && ref.startsWith('#')
          ? 'issue'
          : null
    const kind = explicitKind ?? sigil
    if (!kind) return null
    const bare = ref.replace(/^[#!]/, '')
    return { ref: `${forge === 'gitlab' && kind === 'merge-request' ? '!' : '#'}${bare}`, kind, forge }
  }

  const m = REF_RE.exec(item.notes ?? '')
  if (!m) return null
  const fromSigil: OriginKind | null =
    forge === 'gitlab' ? (m[2] === '!' ? 'merge-request' : 'issue') : null
  // An explicit kind wins over the sigil — the notes of a merge request can mention
  // the issue it closes, and the item is still a merge request.
  const kind = explicitKind ?? fromSigil
  if (!kind) return null
  return { ref: `${forge === 'gitlab' && kind === 'merge-request' ? '!' : '#'}${m[3]}`, kind, forge }
}
