/**
 * Static guards for conventions that have already failed once.
 *
 * These read source files as text. They are deliberately not clever: they do not try to
 * catch a new class of mistake, they catch a rule being deleted — which is how the
 * original defect comes back a year later in a file nobody connected to it.
 *
 * The second guard reads two RENDERER files from a test that lives in `src/main`. That is
 * on purpose: these belong together as "the conventions suite", next to the code that
 * enforces the rest of them, rather than scattered into whichever directory each rule
 * happens to point at.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MAIN_DIR = HERE
const ROOT = path.resolve(HERE, '..', '..')

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listTs(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

function repoPath(full: string): string {
  return path.relative(ROOT, full).split(path.sep).join('/')
}

/** Comments describe rules; only code breaks them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

describe('convention 3 — transcripts are streamed, never slurped', () => {
  /**
   * `jsonl.ts` is the only way this process reads a transcript, and it reads line by line.
   * The reason is size: a long-running session's `.jsonl` runs to hundreds of megabytes,
   * so a whole-file read is an unbounded allocation on the main process — it blocks the
   * UI, and past some point it simply throws (V8 caps string length) and the session
   * becomes unopenable. Streaming has no such ceiling.
   *
   * The check is coarse on purpose: a file that both calls `readFileSync` and mentions
   * `.jsonl` is doing the thing the convention forbids, and a file that legitimately does
   * neither can never trip it.
   */
  const EXEMPT = new Set([
    // The streaming reader itself — it owns the transcript-reading path, and reads the
    // tail/headers deliberately and boundedly.
    'src/main/jsonl.ts'
  ])

  it('reads no .jsonl with readFileSync outside jsonl.ts', () => {
    const offenders = listTs(MAIN_DIR)
      .map(repoPath)
      // Tests are excluded as a category: they write a handful of tiny fixture lines and
      // read them straight back to assert on them (project-files, session-files, tags).
      // That is a fixture, not a transcript, and it is bounded by the test itself.
      .filter((rel) => !rel.endsWith('.test.ts') && !EXEMPT.has(rel))
      .filter((rel) => {
        const src = stripComments(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
        return /\breadFileSync\b/.test(src) && src.includes('.jsonl')
      })

    expect(
      offenders,
      offenders.length
        ? 'These files combine readFileSync with a .jsonl path:\n  ' +
          offenders.join('\n  ') +
          '\nTranscripts reach hundreds of megabytes; a whole-file read blocks the main ' +
          'process and eventually throws outright. Read it through src/main/jsonl.ts, ' +
          'which streams.'
        : undefined
    ).toEqual([])
  })
})

describe('terminal background is one color in two files', () => {
  /**
   * `.chat-terminal-loading` covers the terminal while it boots. It has to be the exact
   * same color as the terminal underneath or the seam shows as the overlay fades — and it
   * cannot read a theme token, because those go near-white in light mode while the
   * terminal stays dark. So the hex is written twice, once in `terminal-theme.ts` and once
   * in `ChatTerminal.css`, and `terminal-theme.ts` ends with a comment asking whoever
   * changes one to remember the other. This test is that comment, enforced.
   *
   * Both files are read as text rather than imported: `terminal-theme.ts` imports a type
   * from `@xterm/xterm`, and a guard should not need the dependency to load in order to
   * compare two strings.
   */
  const THEME_TS = 'src/renderer/src/components/terminal-theme.ts'
  const TERMINAL_CSS = 'src/renderer/src/components/ChatTerminal.css'

  function read(rel: string): string {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
  }

  it('keeps .chat-terminal-loading in sync with TERMINAL_THEME.background', () => {
    const themeMatch = /background:\s*'(#[0-9a-fA-F]{3,8})'/.exec(read(THEME_TS))
    expect(
      themeMatch,
      `no \`background: '#...'\` found in ${THEME_TS} — TERMINAL_THEME lost its background, ` +
        'or the guard needs updating to the new shape'
    ).not.toBeNull()

    const rule = /\.chat-terminal-loading\s*\{([^}]*)\}/.exec(read(TERMINAL_CSS))
    expect(
      rule,
      `no \`.chat-terminal-loading { ... }\` rule found in ${TERMINAL_CSS} — if the loader ` +
        'overlay was renamed, point this guard at the new class'
    ).not.toBeNull()

    const cssMatch = /background:\s*(#[0-9a-fA-F]{3,8})\s*;/.exec(rule![1])
    expect(
      cssMatch,
      `.chat-terminal-loading in ${TERMINAL_CSS} has no literal hex background. It must ` +
        'stay a hardcoded hex: a theme token goes near-white in light mode while the ' +
        'terminal underneath stays dark.'
    ).not.toBeNull()

    const themeBg = themeMatch![1].toLowerCase()
    const cssBg = cssMatch![1].toLowerCase()
    expect(
      cssBg,
      `The loader overlay and the terminal it covers are different colors: ` +
        `${TERMINAL_CSS} paints .chat-terminal-loading ${cssBg}, while ${THEME_TS} sets ` +
        `TERMINAL_THEME.background to ${themeBg}. The overlay sits directly on top of the ` +
        `terminal — any difference shows as a seam. Change both, or neither.`
    ).toBe(themeBg)
  })
})
