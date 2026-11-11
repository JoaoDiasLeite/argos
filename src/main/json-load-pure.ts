/**
 * How to react to the outcome of reading a JSON state file. Pure (no fs, no electron) so
 * the decision is testable on its own; json-file.ts feeds it the real reader.
 *
 * - `missing`: the file does not exist (fresh install) — start on defaults, as always.
 * - `ok`: parsed and accepted.
 * - `corrupt`: the content was read but is not valid JSON, or not the expected shape —
 *   keep a copy before anything overwrites it, then start on defaults.
 * - `unreadable`: the content could not be read at all (EBUSY/EPERM from an antivirus
 *   or sync lock). The file is probably fine, so it must not be quarantined, and nothing
 *   may overwrite it with defaults this session.
 */
export type JsonLoad<T> =
  | { kind: 'missing' }
  | { kind: 'ok'; value: T }
  | { kind: 'corrupt' }
  | { kind: 'unreadable'; error: unknown }

/** `read` is expected to throw like readJsonFile: fs errors carry a `code`, bad JSON is a SyntaxError. */
export function classifyJsonRead<T>(read: () => unknown, accept: (v: unknown) => v is T): JsonLoad<T> {
  let raw: unknown
  try {
    raw = read()
  } catch (e) {
    if (e instanceof SyntaxError) return { kind: 'corrupt' }
    const code = (e as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'unreadable', error: e }
  }
  return accept(raw) ? { kind: 'ok', value: raw } : { kind: 'corrupt' }
}

/** A plain JSON object — not null, not an array. */
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Names of `<base>.corrupt-<ts>` copies to delete so at most `keep` remain (oldest first). */
export function staleCorruptCopies(names: string[], base: string, keep: number): string[] {
  const prefix = `${base}.corrupt-`
  const copies = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)))
  return copies.slice(0, Math.max(0, copies.length - keep))
}
