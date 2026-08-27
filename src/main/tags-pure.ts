/**
 * Tag validation, kept free of `fs` and `electron` so it can be tested directly.
 *
 * Every `custom-tags` line written to a transcript goes through `normalizeTags`
 * first — see `writeSessionTags` in tags.ts for why that belongs at the write
 * point rather than in the IPC handler.
 */

export const MAX_TAGS = 20
export const MAX_TAG_LENGTH = 40

/**
 * Letters (any script, so accents survive), digits, space, underscore, hyphen.
 * Deliberately excludes the characters that would make a tag ambiguous to read
 * back or unsafe to interpolate: quotes, commas, brackets, path separators.
 */
const TAG_CHARS = /^[\p{L}\p{N} _-]+$/u

export class InvalidTagError extends Error {}

/**
 * Trim, drop empties, dedupe, and enforce the count/length/charset limits.
 *
 * Throws `InvalidTagError` rather than silently repairing: a tag the user typed
 * and a tag the app invented are different things, and quietly dropping the
 * invalid part of a set would leave them believing it was saved.
 */
export function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) throw new InvalidTagError('tags must be an array')
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of input) {
    if (typeof raw !== 'string') throw new InvalidTagError('each tag must be a string')
    const t = raw.trim()
    if (!t) continue
    if (t.length > MAX_TAG_LENGTH) throw new InvalidTagError(`tag too long: ${t.slice(0, 20)}…`)
    if (!TAG_CHARS.test(t)) throw new InvalidTagError(`tag has invalid characters: ${t}`)
    // Case-sensitive: "UI" and "ui" are different labels, and merging them for the
    // user is a decision they never asked for. The label manager offers the merge.
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
  }
  if (out.length > MAX_TAGS) throw new InvalidTagError(`too many tags (max ${MAX_TAGS})`)
  return out
}

/** The colour palette new labels are assigned from, in order. */
export const LABEL_PALETTE = [
  '#df7a52',
  '#5cb37e',
  '#7c83ff',
  '#e0a458',
  '#4fb0c6',
  '#c96f9a',
  '#8c7fd6',
  '#6a9955',
  '#d16a5a',
  '#4a90d9',
  '#b0873f',
  '#7fb069'
]

/**
 * The first palette colour no label is using yet, cycling once they run out.
 * `existing` is the set of colours already assigned.
 */
export function nextFreeColor(existing: string[], palette: string[] = LABEL_PALETTE): string {
  const used = new Set(existing.map((c) => c.toLowerCase()))
  const free = palette.find((c) => !used.has(c.toLowerCase()))
  // Cycling by count keeps the assignment deterministic once every colour is taken,
  // instead of everything past the twelfth label sharing one.
  return free ?? palette[existing.length % palette.length]
}
