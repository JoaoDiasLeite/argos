import { storeGet, storeSet } from './store'
import { LABEL_PALETTE, nextFreeColor, normalizeTags } from './tags-pure'
import { countSessionsWithTag, rewriteTagAcrossSessions, scanSessionsWithTag } from './tags-sweep'

/**
 * The label colour registry.
 *
 * This is a user preference, not a record of anything. The attachment of a tag to a
 * conversation lives in the transcript (see tags.ts); all this holds is what colour
 * each label is drawn in and which labels the vocabulary knows about. Losing the file
 * resets colours to palette defaults — no tag is lost.
 */

const STORE_KEY = 'labels'

export interface LabelRegistry {
  palette: string[]
  labels: Record<string, string>
}

export function getLabels(): LabelRegistry {
  const raw = storeGet<Partial<LabelRegistry>>(STORE_KEY, {})
  return {
    palette: Array.isArray(raw.palette) && raw.palette.length ? raw.palette : LABEL_PALETTE,
    labels: raw.labels && typeof raw.labels === 'object' ? raw.labels : {}
  }
}

function save(reg: LabelRegistry): void {
  storeSet(STORE_KEY, reg)
}

/**
 * Give any tag we haven't seen before a colour.
 *
 * Called whenever tags are read or written, so the vocabulary accumulates on its own
 * and a tag applied from outside the app (the CLI, another tool) still gets a colour
 * the first time it shows up. Idempotent and best-effort: it never fails the
 * operation it is riding along with.
 */
export function foldIn(tags: string[]): LabelRegistry {
  const reg = getLabels()
  let dirty = false
  for (const tag of tags) {
    if (reg.labels[tag]) continue
    reg.labels[tag] = nextFreeColor(Object.values(reg.labels), reg.palette)
    dirty = true
  }
  if (dirty) save(reg)
  return reg
}

export function setLabelColor(name: string, color?: string): LabelRegistry {
  const [clean] = normalizeTags([name])
  if (!clean) throw new Error('invalid label name')
  const reg = getLabels()
  reg.labels[clean] = color ?? reg.labels[clean] ?? nextFreeColor(Object.values(reg.labels), reg.palette)
  save(reg)
  return reg
}

export interface LabelUsage {
  count: number
}

export async function labelUsage(name: string): Promise<LabelUsage> {
  return { count: await countSessionsWithTag(name) }
}

export type RenameResult =
  | { ok: true; renamed: number; failed: number }
  /**
   * Renaming onto a name that already exists is a merge, and a merge silently loses
   * a label nobody asked to lose. The UI turns this into an explicit offer, which is
   * why it is a value the renderer can branch on rather than a thrown error.
   */
  | { ok: false; error: 'label-exists'; target: string; count: number }

export async function renameLabel(from: string, to: string): Promise<RenameResult> {
  const [target] = normalizeTags([to])
  if (!target) throw new Error('invalid label name')
  if (target === from) return { ok: true, renamed: 0, failed: 0 }

  const reg = getLabels()
  const existsInRegistry = !!reg.labels[target]
  const inUse = await countSessionsWithTag(target)
  if (existsInRegistry || inUse > 0) {
    return { ok: false, error: 'label-exists', target, count: inUse }
  }

  const { changed, failed } = await rewriteTagAcrossSessions(from, (tags) =>
    tags.map((t) => (t === from ? target : t))
  )
  // A partial sweep leaves the registry alone: renaming the entry while the old name
  // is still applied somewhere would strand that name outside the registry, and the
  // next fold-in would resurrect it with a fresh colour.
  if (failed === 0) {
    reg.labels[target] = reg.labels[from] ?? nextFreeColor(Object.values(reg.labels), reg.palette)
    delete reg.labels[from]
    save(reg)
  }
  return { ok: true, renamed: changed, failed }
}

export async function mergeLabel(from: string, into: string): Promise<{ merged: number; failed: number }> {
  const [target] = normalizeTags([into])
  if (!target) throw new Error('invalid label name')
  if (target === from) return { merged: 0, failed: 0 }

  const reg = getLabels()
  const { changed, failed } = await rewriteTagAcrossSessions(from, (tags) => {
    const next = tags.map((t) => (t === from ? target : t))
    // normalizeTags dedupes, but a conversation carrying both names would otherwise
    // reach it as a duplicate pair — the exact shape the write-point rule exists for.
    return next
  })
  if (failed === 0) {
    // The target keeps its own colour; it only inherits when it had none.
    if (!reg.labels[target]) {
      reg.labels[target] = reg.labels[from] ?? nextFreeColor(Object.values(reg.labels), reg.palette)
    }
    delete reg.labels[from]
    save(reg)
  }
  return { merged: changed, failed }
}

/**
 * Remove a label everywhere, then drop it from the registry.
 *
 * Always cascades. Clearing only the registry entry looks like it worked and then
 * undoes itself: the tag is still on the conversations, and the next fold-in puts it
 * back with a new colour. That was a real bug in FRIDAY, and the reason there is no
 * non-cascading variant here.
 */
export async function deleteLabel(name: string): Promise<{ cleared: number; failed: number }> {
  const { changed, failed } = await rewriteTagAcrossSessions(name, (tags) =>
    tags.filter((t) => t !== name)
  )
  if (failed === 0) {
    const reg = getLabels()
    delete reg.labels[name]
    save(reg)
  }
  return { cleared: changed, failed }
}

/**
 * The vocabulary: every label in the registry, plus every tag currently applied.
 * The union is what the filter bar and the autocomplete offer.
 */
export async function labelVocabulary(): Promise<LabelRegistry> {
  const reg = getLabels()
  // Only registry keys are cheap to read; applied-but-unregistered tags arrive via
  // foldIn as sessions are listed, which is the path that actually reads them.
  return reg
}

/** Sessions carrying a label — used by the manager to show what a verb will touch. */
export async function sessionsWithLabel(name: string): Promise<number> {
  return (await scanSessionsWithTag(name)).length
}
