/**
 * Turning transcript entries into the short strings the UI shows — titles and
 * previews. Pure: no `fs`, no `electron`.
 *
 * The Claude Code CLI wraps a lot of machinery in the user's own channel. A slash
 * command records its own name and body there; a loaded skill records its whole
 * text; the harness injects reminders. None of that is what the person typed, and
 * all of it lands first in the transcript — so a naive "first user message" reads
 * back the plumbing instead of the conversation.
 *
 * Measured on one real project: 14 of 52 sessions showed raw `<local-command-caveat>`
 * or `<command-message>` markup as their title.
 */

/**
 * Paired `<command-*>` / `<local-command-*>` blocks, content included.
 *
 * Deliberately generic — matching the tag name with a backreference rather than
 * enumerating the variants. The CLI adds new ones (`command-args`,
 * `local-command-stdout`, …) without asking, and a list would need editing every
 * time; a shape does not.
 */
const COMMAND_BLOCK = /<((?:local-)?command-[a-z-]+)>[\s\S]*?<\/\1>/gi

/** The same tags left unpaired — a truncated write, or a block the CLI never closed. */
const COMMAND_TAG = /<\/?(?:local-)?command-[a-z-]+>/gi

/** Harness injections into the user's channel. */
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/gi

/** A leading `/command` line, with or without arguments. */
const LEADING_SLASH_COMMAND = /^\s*\/[a-z0-9][a-z0-9:_-]*(?:[ \t][^\n]*)?\n?/i

export function stripReminders(text: string): string {
  return text.replace(SYSTEM_REMINDER, '')
}

export function stripCommandBlocks(text: string): string {
  return text.replace(COMMAND_BLOCK, '').replace(COMMAND_TAG, '')
}

/** Flatten a message's `content` (string or block array) to its plain text. */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (!b || typeof b !== 'object') return ''
        const block = b as { type?: string; text?: unknown }
        return block.type === 'text' || typeof block.text === 'string' ? String(block.text ?? '') : ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

/**
 * What the person actually typed, or '' if this entry carries none of it.
 *
 * Returning '' rather than the raw text is what lets the caller fall through to the
 * next user entry: a session that opens with a slash command shows the prose that
 * followed it, which is the thing worth reading.
 */
export function meaningfulUserText(content: unknown): string {
  let text = contentToText(content)
  if (!text) return ''
  text = stripCommandBlocks(stripReminders(text))
  text = text.replace(LEADING_SLASH_COMMAND, '')
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The comparison key for "is this the same opening as that one".
 *
 * Case- and whitespace-insensitive, and only the first stretch: two runs of the same
 * command diverge after the boilerplate (different file lists, different repos), so
 * comparing whole previews would find no duplicates at all.
 */
export function previewKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60)
}

/**
 * Letters and digits only. Titles are generated *from* the opening message, so the
 * two differ by punctuation and a filler word far more often than by meaning —
 * "What's left to do" against "whats left to do?", "Deploy the unreleased version"
 * against "lets deploy the unreleased version".
 */
function wordKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** How much longer the preview may be and still count as a restatement. */
const RESTATEMENT_SLACK = 12

/**
 * Does the preview just restate the title?
 *
 * Containment either way, with a slack — the preview can't be adding much if it is
 * barely longer than the title it contains. Requiring a prefix match missed every
 * case with a leading "lets" or "can you"; dropping the slack and allowing plain
 * containment would suppress a preview that genuinely elaborates on its title.
 */
export function previewRestatesTitle(preview: string, title: string): boolean {
  const p = wordKey(preview)
  const t = wordKey(title)
  if (!p || !t) return false
  const [shorter, longer] = p.length <= t.length ? [p, t] : [t, p]
  return longer.includes(shorter) && longer.length - shorter.length <= RESTATEMENT_SLACK
}

/**
 * How many sessions in this project must share an opening before it counts as a
 * template rather than a coincidence.
 *
 * Two conversations can legitimately start the same way. Three is a command being
 * re-run, and at that point the line has stopped telling them apart — which is the
 * only job a preview has.
 */
export const BOILERPLATE_MIN = 3

/**
 * Given every preview in a project, the set of keys that are boilerplate.
 *
 * Scoped to the project on purpose: `/security-review` is noise in a repo where it
 * runs weekly and is a perfectly good preview in one where it ran once.
 */
export function boilerplateKeys(previews: string[], min = BOILERPLATE_MIN): Set<string> {
  const counts = new Map<string, number>()
  for (const p of previews) {
    const k = previewKey(p)
    if (!k) continue
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  const out = new Set<string>()
  for (const [k, n] of counts) if (n >= min) out.add(k)
  return out
}
