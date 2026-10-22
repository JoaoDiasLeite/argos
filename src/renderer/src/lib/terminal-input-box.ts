/**
 * Reading Claude Code's input box off the terminal screen, to tell whether a prompt typed
 * into it was submitted. Pure: the caller passes the rows on screen as text.
 */

/** A full-width rule of the CLI's input box (`────…`). */
const INPUT_RULE_RE = /^\s*─{20,}\s*$/

/**
 * Whether the CLI's input box still holds `text`, i.e. it was typed but not submitted.
 * Claude Code draws its input between the last two `────` rules on screen, with a caret
 * of its own (the terminal's real cursor sits elsewhere, so it cannot be used). The box's
 * rows are joined, since a long prompt wraps, and the prompt's tail is looked for there.
 * Without two rules on screen this answers false: nothing is resent on a guess.
 */
export function inputBoxHolds(rows: string[], text: string): boolean {
  const rules: number[] = []
  for (let i = rows.length - 1; i >= 0 && rules.length < 2; i--) {
    if (INPUT_RULE_RE.test(rows[i])) rules.push(i)
  }
  if (rules.length < 2) return false
  const [bottom, top] = rules
  const norm = (s: string) => s.replace(/\s+/g, '')
  const box = norm(rows.slice(top + 1, bottom).join(''))
  const tail = norm(text).slice(-20)
  return tail.length >= 4 && box.includes(tail)
}
