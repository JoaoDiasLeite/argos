/**
 * The two search depths, over one collector.
 *
 * `collectMatches` is the matcher both use. What differs is what they feed it:
 * `proseSegments` is what a person wrote or the assistant said, and it is what a
 * search inside one project looks at; `searchableSegments` adds tool inputs and tool
 * results, which is what a search across everything looks at. Anything else — a
 * search that recomputes its own matching per depth — ends up with two definitions
 * of a hit that drift apart.
 *
 * Pure: no `fs`, no `electron`.
 */
import { askDecisionText, askQuestionText } from './ask-answers-pure'
import { contentToText, isInjectedUserEntry, stripReminders } from './transcript-text'

export type SegmentKind = 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'

export interface Segment {
  kind: SegmentKind
  text: string
}

export interface SearchSnippet {
  kind: SegmentKind
  before: string
  match: string
  after: string
}

export interface Matches {
  matchCount: number
  snippets: SearchSnippet[]
}

/** How much context surrounds a hit in the snippet. */
const SNIPPET_PAD = 60

export function collectMatches(
  segments: Segment[],
  query: string,
  { snippetCap = 3 }: { snippetCap?: number } = {}
): Matches {
  // An empty query would make indexOf('', from) return `from` for ever — `from`
  // advances by lower.length, which is zero — and spin. Nothing matches "nothing",
  // and the guard belongs here because this is the shared helper.
  if (!query) return { matchCount: 0, snippets: [] }
  const lower = query.toLowerCase()
  let matchCount = 0
  const snippets: SearchSnippet[] = []
  for (const { kind, text } of segments) {
    if (!text) continue
    const lt = text.toLowerCase()
    let from = 0
    for (;;) {
      const idx = lt.indexOf(lower, from)
      if (idx === -1) break
      matchCount++
      if (snippets.length < snippetCap) {
        let start = Math.max(0, idx - SNIPPET_PAD)
        let end = Math.min(text.length, idx + lower.length + SNIPPET_PAD)
        // Never cut through a surrogate pair: half an emoji renders as �. Nudge the
        // bounds off an orphaned low/high surrogate.
        if (start > 0 && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) start++
        if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end--
        snippets.push({
          kind,
          before: (start > 0 ? '…' : '') + text.slice(start, idx),
          match: text.slice(idx, idx + lower.length),
          after: text.slice(idx + lower.length, end) + (end < text.length ? '…' : '')
        })
      }
      from = idx + lower.length
    }
  }
  return { matchCount, snippets }
}

/** The text of a `tool_result` block, whether it came as a string or as blocks. */
function toolResultToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c === 'object' ? String((c as { text?: unknown }).text ?? '') : '')).join('')
  }
  return ''
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Everything of one entry a reader can see: prose, tool inputs, tool results.
 * Thinking and metadata stay out. This is the wider of the two depths.
 */
export function searchableSegments(obj: any): Segment[] {
  const out: Segment[] = []
  if (obj?.type === 'user') {
    const content = obj.message?.content
    if (Array.isArray(content)) {
      const results = content.filter((b: any) => b?.type === 'tool_result')
      if (results.length > 0) {
        for (const tr of results) {
          const text = toolResultToText(tr.content)
          if (!text) continue
          // The same exception `proseSegments` makes, for the same reason: an answer
          // to AskUserQuestion is the owner's. Both depths must call it the same
          // thing, or one decision is his prose in one search and a tool's output in
          // the other.
          const decision = askDecisionText(text, !!tr.is_error)
          out.push(decision ? { kind: 'user', text: decision } : { kind: 'tool_result', text })
        }
        return out
      }
    }
    const text = stripReminders(contentToText(content))
    // A CLI injection is still indexed — searching inside a loaded skill is a fair
    // thing to want — but the snippet does not put the owner's name on it.
    if (text) out.push({ kind: isInjectedUserEntry(obj) ? 'system' : 'user', text })
    return out
  }
  if (obj?.type === 'assistant') {
    const blocks = obj.message?.content
    if (!Array.isArray(blocks)) return out
    for (const b of blocks) {
      if (!b) continue
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        out.push({ kind: 'assistant', text: b.text })
      } else if (b.type === 'tool_use') {
        // A clarification's question is the assistant's prose, not a tool
        // invocation: indexing the raw JSON gives snippets of `"questions":` rather
        // than the statement the owner read.
        const asked = b.name === 'AskUserQuestion' ? askQuestionText(b.input) : null
        out.push(
          asked
            ? { kind: 'assistant', text: asked }
            : { kind: 'tool_use', text: JSON.stringify(b.input ?? {}, null, 2) }
        )
      }
    }
    return out
  }
  return out
}

/**
 * Only the prose of one entry — tool inputs and tool results left out. It is the
 * narrower depth, the one a search inside a single project uses.
 */
export function proseSegments(obj: any): Segment[] {
  const out: Segment[] = []
  if (obj?.type === 'user') {
    const content = obj.message?.content
    if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) {
      // The one exception to "a tool result is not prose": an answer to
      // AskUserQuestion is a choice of the owner's. Without it, searching for a
      // decision he made does not return the conversation he made it in.
      //
      // There is no `tool_use` to hand here — this runs entry by entry, without
      // state — and none is needed: the result string already carries both the
      // question and the choice.
      for (const b of content) {
        if (b?.type !== 'tool_result') continue
        const decision = askDecisionText(toolResultToText(b.content), !!b.is_error)
        if (decision) out.push({ kind: 'user', text: decision })
      }
      return out
    }
    const text = stripReminders(contentToText(content))
    if (text) out.push({ kind: isInjectedUserEntry(obj) ? 'system' : 'user', text })
    return out
  }
  if (obj?.type === 'assistant') {
    const blocks = obj.message?.content
    if (!Array.isArray(blocks)) return out
    const text = blocks
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
    if (text) out.push({ kind: 'assistant', text })
    return out
  }
  return out
}

/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * May a raw-line substring test stand in for building this entry's segments?
 *
 * Skipping the segment build for lines that cannot match is most of what makes a
 * sweep over every transcript affordable. But the raw line is JSON, so a quote in
 * the text is `\"` there and a newline is `\n` — a query carrying either would be
 * excluded from lines that genuinely match. A prefilter is only allowed to let
 * extra lines through, never to drop one, so those queries do without it.
 */
export function rawPrefilterable(query: string): boolean {
  return !/["\\\n\r\t]/.test(query)
}

/** Flatten a snippet for callers that want one plain line. */
export function snippetText(s: SearchSnippet): string {
  return `${s.before}${s.match}${s.after}`.replace(/\s+/g, ' ').trim()
}
