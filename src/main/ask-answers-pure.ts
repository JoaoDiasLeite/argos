/**
 * Reading back the choices the *owner* made mid-task.
 *
 * When the assistant asks for a clarification, the exchange is recorded as two
 * things: an `AskUserQuestion` `tool_use` carrying the questions and options as
 * structure, and a `tool_result` carrying the answer as prose —
 * `Your questions have been answered: "<question>"="<choice>", …`.
 *
 * A viewer that draws both as tool I/O prints the owner's decision in grey
 * monospace without his name on it. It is the mirror of the injected-user-entry
 * problem: there, the CLI's text was attributed to the owner; here, the owner's
 * text is attributed to a machine.
 *
 * Everything here returns null rather than guessing. The format is the harness's,
 * not this repo's, and it can change without notice — on the day it does, the
 * viewer falls back to the tool bubbles instead of drawing a wrong block.
 *
 * Pure: no `fs`, no `electron`.
 */

export const ASK_RESULT_PREFIX = 'Your questions have been answered:'

/** One question's outcome. `rejected` is derived, never parsed. */
export interface AskDecision {
  question: string
  header: string
  chosen: string[]
  /** Free text the owner typed — the "Other" option — or null. */
  custom: string | null
  rejected: string[]
}

interface AskOption {
  label?: unknown
  description?: unknown
}

interface AskQuestion {
  question?: unknown
  header?: unknown
  options?: AskOption[]
}

/**
 * The harness appends the chosen mockup after the answer. It is noise in the block
 * and in the search index alike — and it can contain commas and quotes, which would
 * confuse any reading of the text around it.
 */
const PREVIEW_MARK = ' selected preview:'

/** The harness's closing sentence, which is not part of anyone's answer. */
const TRAILER = /\.?\s*You can now continue[\s\S]*$/

/**
 * The same, from the end of the last answer's value — where the closing quote of
 * that answer runs straight into the sentence. Stripping the quote separately
 * would leave it behind on the one answer the trailer follows.
 */
const VALUE_TRAILER = /"?\.?\s*You can now continue[\s\S]*$/

/**
 * Cut every mockup block: from the marker to the start of the next answer (`, "`)
 * or to the end.
 *
 * Exported because search needs the same cut without the rest of the parser — it
 * runs entry by entry and has no `tool_use` to hand.
 */
export function stripPreviewBlocks(text: string): string {
  if (typeof text !== 'string') return ''
  let out = ''
  let i = 0
  for (;;) {
    const mark = text.indexOf(PREVIEW_MARK, i)
    if (mark === -1) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, mark)
    const next = text.indexOf(', "', mark)
    // The last preview: all that follows is the trailer, which belongs to neither
    // the block nor the index.
    if (next === -1) break
    i = next
  }
  return out
}

function labelsOf(q: AskQuestion): string[] {
  const options = Array.isArray(q.options) ? q.options : []
  return options.map((o) => o?.label).filter((l): l is string => typeof l === 'string')
}

/**
 * Pair an `AskUserQuestion` input with its result. Null when it cannot be read.
 *
 * Anchored on the exact statements from the `tool_use` rather than matched with a
 * regex over quotes: a question can contain quotes — measured, on a real session:
 * «Which entries should move to the grey "system" bubble?» — and
 * `/"([^"]+)"="([^"]+)"/` cuts it in half.
 */
export function parseAskAnswers(questions: unknown, resultText: unknown): AskDecision[] | null {
  if (!Array.isArray(questions) || questions.length === 0) return null
  if (typeof resultText !== 'string' || !resultText.startsWith(ASK_RESULT_PREFIX)) return null

  // Where each question's answer starts. A question with no anchor was not answered
  // (or the format changed) — it drops out, and if none anchor there is nothing to
  // draw.
  const anchors: { q: AskQuestion; start: number; valueAt: number }[] = []
  for (const raw of questions as AskQuestion[]) {
    if (!raw || typeof raw.question !== 'string') continue
    const marker = `"${raw.question}"="`
    const at = resultText.indexOf(marker)
    if (at === -1) continue
    anchors.push({ q: raw, start: at, valueAt: at + marker.length })
  }
  if (anchors.length === 0) return null
  anchors.sort((a, b) => a.start - b.start)

  const out: AskDecision[] = []
  for (let i = 0; i < anchors.length; i++) {
    const { q, valueAt } = anchors[i]
    // The value ends where the next answer begins; on the last one, at the trailer
    // the harness appends.
    const end = i + 1 < anchors.length ? anchors[i + 1].start : resultText.length
    let value = resultText.slice(valueAt, end)
    const preview = value.indexOf(PREVIEW_MARK)
    if (preview !== -1) value = value.slice(0, preview)
    value = value
      .replace(VALUE_TRAILER, '')
      .replace(/[,\s]+$/, '')
      .replace(/"$/, '')
      .trim()
    out.push({
      ...matchLabels(q, value),
      question: q.question as string,
      header: typeof q.header === 'string' ? q.header : ''
    })
  }
  return out.length ? out : null
}

/**
 * Find the known labels inside the answer.
 *
 * Longest first, removing what matched: without that, a label that is a prefix of
 * another ("Yes" inside "Yes, fix everything") matches twice. A `split(', ')` would
 * be simpler and would be wrong — a label can contain a comma, and
 * "Yes, fix everything (Recommended)" is a real one.
 */
function matchLabels(q: AskQuestion, value: string): Pick<AskDecision, 'chosen' | 'custom' | 'rejected'> {
  const labels = labelsOf(q)
  const chosen: string[] = []
  let rest = value
  for (const label of [...labels].sort((a, b) => b.length - a.length)) {
    const at = rest.indexOf(label)
    if (at === -1) continue
    chosen.push(label)
    rest = rest.slice(0, at) + rest.slice(at + label.length)
  }
  // Presented in the options' order, not in length order.
  chosen.sort((a, b) => labels.indexOf(a) - labels.indexOf(b))
  // Only the ends and the holes the removed labels left behind: replacing commas
  // globally would eat the punctuation of text the owner typed by hand.
  const custom = rest
    .replace(/\s*,\s*(?=,)/g, '')
    .replace(/^[,\s]+|[,\s]+$/g, '')
    .trim()
  return {
    chosen,
    // Whatever is left is the "Other" option — text the owner wrote himself.
    custom: custom.length > 1 ? custom : null,
    rejected: labels.filter((l) => !chosen.includes(l))
  }
}

/**
 * The readable text of an `AskUserQuestion` answer, or null if it is not one.
 *
 * Shared by both search depths so the decision has one identity: without it, the
 * same choice would be the owner's prose in one search and "tool output" in the
 * other.
 */
export function askDecisionText(text: unknown, isError = false): string | null {
  if (isError) return null
  if (typeof text !== 'string' || !text.startsWith(ASK_RESULT_PREFIX)) return null
  const clean = stripPreviewBlocks(text).replace(TRAILER, '').trim()
  return clean || null
}

/**
 * A question and its options as prose. It is what the owner read when he decided,
 * and that is what he searches for later — not the shape of the input. Indexing the
 * raw JSON gives snippets of `"questions":` instead of the statement itself.
 */
export function askQuestionText(input: unknown): string | null {
  const questions = (input as { questions?: unknown })?.questions
  if (!Array.isArray(questions) || questions.length === 0) return null
  const parts: string[] = []
  for (const q of questions as AskQuestion[]) {
    if (!q || typeof q.question !== 'string') continue
    parts.push(q.question)
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (!o || typeof o.label !== 'string') continue
      parts.push(typeof o.description === 'string' && o.description ? `${o.label} — ${o.description}` : o.label)
    }
  }
  return parts.length ? parts.join('\n') : null
}

/**
 * One message of a read transcript, as far as this module needs to know it.
 *
 * Structural on purpose: the pairing is the half worth testing and it must not
 * need a transcript on disk to run.
 */
export interface DecidableMessage {
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolCalls: { id: string; tool: string; input: unknown; result?: string; isError?: boolean }[]
  timestamp: number
  decisions?: AskDecision[]
}

/**
 * Turn each recognised `AskUserQuestion` pair into a turn of the owner's.
 *
 * The question is a `tool_use` and the answer a `tool_result`, so a viewer that
 * knows only about tools prints the owner's decision as machine output with nobody's
 * name on it — the mirror of the injected-user-entry problem.
 *
 * The tool call is dropped **only when the parser returned something**. The format
 * is the harness's and can change without notice; on that day this falls back to the
 * two tool bubbles rather than drawing a block it half understood.
 *
 * Runs after the results are stitched onto their calls, because until then no
 * message knows its own answer.
 */
export function withDecisions(messages: DecidableMessage[]): DecidableMessage[] {
  const out: DecidableMessage[] = []
  for (const m of messages) {
    const decisions: AskDecision[] = []
    const kept: DecidableMessage['toolCalls'] = []
    for (const t of m.toolCalls) {
      const parsed =
        t.tool === 'AskUserQuestion' && !t.isError
          ? parseAskAnswers((t.input as { questions?: unknown })?.questions, t.result)
          : null
      if (parsed) decisions.push(...parsed)
      else kept.push(t)
    }
    if (!decisions.length) {
      out.push(m)
      continue
    }
    m.toolCalls = kept
    // An assistant turn that was nothing but the question has nothing left to say —
    // the block carries the question itself.
    if (m.text || m.thinking || kept.length) out.push(m)
    out.push({
      // The owner's turn: it is his choice, and counting or walking the conversation
      // should treat it as one.
      role: 'user',
      text: '',
      toolCalls: [],
      timestamp: m.timestamp,
      decisions
    })
  }
  return out
}
