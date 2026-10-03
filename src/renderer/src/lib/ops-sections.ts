/**
 * A runbook script's output split into its sections. Argos sees a script as one process,
 * so the split relies on a convention: the script prints `== title ==` before each check.
 * Pure: the activity column renders what comes back.
 */

export interface OpsOutputSection {
  /** The text between the `==` markers; empty for output before the first marker. */
  title: string
  body: string
}

const HEADER_RE = /^==\s*(.+?)\s*==\s*$/

/**
 * The sections of `stdout`, or null when it has no marker line (plain output stays plain).
 * Text before the first marker is kept as an untitled section so nothing is dropped.
 */
export function splitSections(stdout: string): OpsOutputSection[] | null {
  const sections: OpsOutputSection[] = []
  let current: { title: string; lines: string[] } | null = null
  let sawHeader = false
  const flush = (): void => {
    if (!current) return
    const body = current.lines.join('\n').replace(/^\n+|\s+$/g, '')
    if (current.title !== '' || body !== '') sections.push({ title: current.title, body })
  }
  for (const line of stdout.replace(/\r\n/g, '\n').split('\n')) {
    const m = HEADER_RE.exec(line)
    if (m) {
      flush()
      sawHeader = true
      current = { title: m[1], lines: [] }
    } else {
      if (!current) current = { title: '', lines: [] }
      current.lines.push(line)
    }
  }
  flush()
  return sawHeader ? sections : null
}
