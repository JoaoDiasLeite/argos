/**
 * The decisions behind editing a project's own backlog record, with nothing that
 * touches the disk — which file counts as the record, what a checkbox line is, which
 * line an edit is actually addressing, and how one line changes without disturbing
 * the rest of the file.
 *
 * Split out because this is the half worth testing. The file being edited is the
 * user's, tracked in git, and read by people who have never heard of this app: every
 * rule below exists because breaking it produces a diff they did not ask for. The fs
 * half (`backlog.ts`) only reads, calls in here, and writes back.
 */

/** One checkbox line in the primary record. */
export interface BacklogTopic {
  /**
   * 0-based line index in the file as it was last read — the address every edit tries
   * first. Text is only the fallback, because two identical lines make text alone
   * write to whichever came first.
   */
  line: number
  /** The text after the checkbox, trimmed. */
  title: string
  done: boolean
  /** Nearest heading above the line, or null when it sits before any. */
  section: string | null
  /** Leading whitespace, kept so an edit or a duplicate holds its nesting. */
  indent: string
}

// ─── Which file is the record ─────────────────────────────────────────────────

/** Lower is better. A project that keeps several of these means the first one. */
const NAME_RANK: Record<string, number> = {
  backlog: 0,
  todo: 1,
  tasks: 2,
  roadmap: 3
}

/**
 * Pick the primary record out of the relative paths that actually exist.
 *
 * Two rules, both about not surprising the user. The name is matched whole — a
 * project with `OLD-BACKLOG.md` archived beside a live `TODO.md` must get `TODO.md`,
 * because a substring match would quietly make the archive the thing every tick
 * writes into. And the root beats `docs/`: a record at the top of the repo is the one
 * the reader sees first, so it is the one Argos edits.
 *
 * Input is relative paths in either separator style; the winner comes back with
 * forward slashes, which is what the UI shows and what the caller re-joins.
 */
export function pickPrimary(relPaths: string[]): string | null {
  let best: { rel: string; name: number; depth: number } | null = null
  for (const raw of relPaths) {
    if (typeof raw !== 'string' || raw.length === 0) continue
    const rel = raw.replace(/\\/g, '/').replace(/^\.\//, '')
    const parts = rel.split('/')
    const file = parts[parts.length - 1]
    const dir = parts.slice(0, -1).join('/').toLowerCase()
    // Only the root and `docs/`; anything deeper is somebody's notes, not the record.
    const depth = dir === '' ? 0 : dir === 'docs' ? 1 : -1
    if (depth < 0) continue
    const m = /^(.+)\.md$/i.exec(file)
    if (!m) continue
    const name = NAME_RANK[m[1].toLowerCase()]
    if (name === undefined) continue
    if (
      best === null ||
      name < best.name ||
      // Same name in both places: the root copy wins.
      (name === best.name && depth < best.depth)
    ) {
      best = { rel, name, depth }
    }
  }
  return best ? best.rel : null
}

// ─── Reading the file ─────────────────────────────────────────────────────────

const TASK_RE = /^(\s*)([-*+])(\s+)\[([ xX])\](\s*)(.*)$/
const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE_RE = /^\s*(```+|~~~+)/

/**
 * Every checkbox line in the file, in order, each carrying enough context to be put
 * back exactly as it was found.
 *
 * Fenced blocks are skipped, and that is not pedantry: a backlog that documents its
 * own format has ` - [ ] like this ` inside a code fence, and treating that as a topic
 * puts an example in the user's list and — worse — lets a tick rewrite a sample. The
 * fence has to close with the same character it opened with, or a ``` block quoting a
 * ~~~ one swallows the rest of the file.
 */
export function parseTopics(text: string): BacklogTopic[] {
  const lines = text.split('\n')
  const topics: BacklogTopic[] = []
  let section: string | null = null
  let fence: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue

    const heading = HEADING_RE.exec(line)
    if (heading) {
      section = heading[2].trim()
      continue
    }

    const task = TASK_RE.exec(line)
    if (!task) continue
    topics.push({
      line: i,
      title: task[6].trim(),
      done: task[4] !== ' ',
      section,
      indent: task[1]
    })
  }
  return topics
}

/** Unticked topics across the whole file — the number the UI is allowed to show. */
export function countPending(topics: BacklogTopic[]): number {
  return topics.filter((t) => !t.done).length
}

/** Ticked topics across the whole file. */
export function countDone(topics: BacklogTopic[]): number {
  return topics.filter((t) => t.done).length
}

// ─── Which line an edit is addressing ─────────────────────────────────────────

export type LocateResult =
  | { ok: true; line: number }
  | { ok: false; error: 'stale' }
  | { ok: false; error: 'ambiguous'; matches: number }

/**
 * Resolve a ref to a line: index first, text only as a fallback.
 *
 * This is the invariant the whole feature exists for. FRIDAY addressed topics with a
 * bare text `findIndex`, so ticking the second of two identically-worded lines ticked
 * the first, and nobody noticed until someone duplicated a topic. So: if a topic sits
 * at `ref.line` and still reads the same, that is the answer and no search happens at
 * all. Only when the file has shifted under the view do we look by title, and then
 * one match is the answer, none is `stale` (reload — it was deleted or reworded), and
 * several is `ambiguous`, which the user has to settle. Guessing there is the bug.
 *
 * Titles compare trimmed but case-sensitively: two topics differing only in case are
 * two topics, and folding them together re-creates the ambiguity this exists to catch.
 */
export function locateTopic(
  topics: BacklogTopic[],
  ref: { line: number; title: string }
): LocateResult {
  const wanted = (ref?.title ?? '').trim()
  const atIndex = topics.find((t) => t.line === ref?.line)
  if (atIndex && atIndex.title === wanted) return { ok: true, line: atIndex.line }

  const matches = topics.filter((t) => t.title === wanted)
  if (matches.length === 1) return { ok: true, line: matches[0].line }
  if (matches.length === 0) return { ok: false, error: 'stale' }
  return { ok: false, error: 'ambiguous', matches: matches.length }
}

// ─── Line transforms ──────────────────────────────────────────────────────────
//
// Each takes the file's lines and returns a new array. They touch one line and leave
// every other byte alone: the point of editing a markdown record in place is that the
// resulting git diff is one line long. Anything that reflows, re-indents or
// re-normalises the file makes a tick look like a rewrite, and a feature whose diffs
// look like that gets turned off.

/** Flip only the marker, keeping indent, bullet character and trailing text exactly. */
export function setDoneAt(lines: string[], line: number, done: boolean): string[] {
  return replaceLine(lines, line, (text) =>
    text.replace(/^(\s*[-*+]\s+\[)[ xX](\])/, `$1${done ? 'x' : ' '}$2`)
  )
}

/** Replace the title, keeping indent, bullet, marker and the spacing between them. */
export function editAt(lines: string[], line: number, title: string): string[] {
  const next = title.trim()
  return replaceLine(lines, line, (text) => {
    const m = TASK_RE.exec(text)
    if (!m) return text
    // A checkbox with no space after it is malformed markdown in most renderers;
    // restore one rather than write the title flush against the bracket.
    const gap = m[5].length > 0 ? m[5] : ' '
    return `${m[1]}${m[2]}${m[3]}[${m[4]}]${gap}${next}`
  })
}

/**
 * Insert a copy of the line immediately after the original.
 *
 * Immediately after, never appended at the end: a topic belongs to the section it sits
 * under, and a copy that lands at the bottom of the file has silently changed sections
 * — which defeats the only reason the file is organised into them.
 */
export function duplicateAt(lines: string[], line: number): string[] {
  if (!inRange(lines, line)) return lines.slice()
  const out = lines.slice()
  out.splice(line + 1, 0, lines[line])
  return out
}

/** Remove that one line and nothing else. */
export function deleteAt(lines: string[], line: number): string[] {
  if (!inRange(lines, line)) return lines.slice()
  const out = lines.slice()
  out.splice(line, 1)
  return out
}

/**
 * Add a new unticked topic.
 *
 * With a section, it lands at the end of that section's run of topics — after its last
 * task line, before the next heading — because a topic appended to the bottom of the
 * file is filed under whatever heading happens to be last, which is rarely the one the
 * user was looking at. With no section, or one the file does not have, it goes at the
 * end, which is the honest answer rather than a guess at where it belongs.
 *
 * The file's trailing newline is left as it was found. `lines` comes from splitting the
 * content, so a file ending in a newline has an empty final element; inserting before
 * it keeps exactly one trailing newline, and a file that had none does not gain one.
 */
export function appendTopic(
  lines: string[],
  title: string,
  section: string | null,
  indent = ''
): string[] {
  const entry = `${indent}- [ ] ${title.trim()}`
  const out = lines.slice()
  const at = sectionInsertPoint(out, section)
  out.splice(at, 0, entry)
  return out
}

/** Where a new topic goes: end of the named section's run, else end of the file. */
function sectionInsertPoint(lines: string[], section: string | null): number {
  const endOfFile = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (section === null || section.trim() === '') return endOfFile

  const wanted = section.trim()
  let start = -1
  let fence: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].replace(/\r$/, '')
    const f = FENCE_RE.exec(text)
    if (f) {
      const marker = f[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const h = HEADING_RE.exec(text)
    if (h && h[2].trim() === wanted) {
      start = i
      break
    }
  }
  // An unknown section is not an error worth refusing over — the file may have been
  // reorganised since the UI last read it. Append and let the user move it.
  if (start < 0) return endOfFile

  let last = start
  fence = null
  for (let i = start + 1; i < lines.length; i++) {
    const text = lines[i].replace(/\r$/, '')
    const f = FENCE_RE.exec(text)
    if (f) {
      const marker = f[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    if (HEADING_RE.test(text)) break
    // Track the last line with anything on it, so the new topic sits against the run
    // rather than after the blank line that separates it from the next heading.
    if (text.trim() !== '') last = i
  }
  return last + 1
}

function inRange(lines: string[], line: number): boolean {
  return Number.isInteger(line) && line >= 0 && line < lines.length
}

function replaceLine(lines: string[], line: number, fn: (text: string) => string): string[] {
  if (!inRange(lines, line)) return lines.slice()
  const out = lines.slice()
  out[line] = fn(lines[line])
  return out
}
