/**
 * Guard: CSS class names must be scoped.
 *
 * `shared.css` states the rule in the codebase's own words:
 *
 *   "Because every component/view stylesheet is bundled into one global sheet, two files
 *    defining the same bare class name silently collide (whichever lands later in the
 *    bundle wins, or properties merge in unpredictable ways). [...] Component-specific
 *    visual refinements belong in the component's own stylesheet as SCOPED overrides
 *    (e.g. `.mcp-card-head .badge { ... }`, `.settings-modal .btn-primary { ... }`) —
 *    never as a second bare re-definition of these selectors."
 *
 * The Projects rework proved it the expensive way: it named its rows `.session-row`, a
 * class the sidebar already owned, and every chat row in the app turned into a
 * five-column grid. Nothing about that failure was visible in the file being edited —
 * which is exactly why it needs a test and not a comment.
 *
 * This guard does not try to catch novel-but-fine styling. It catches the rule being
 * deleted: a NEW bare collision appearing, or a baselined one being quietly forgotten.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// src/renderer/src/lib -> src/renderer
const RENDERER_DIR = path.resolve(HERE, '..', '..')

/**
 * Base stylesheets. These exist precisely to be re-styled from a component: `shared.css`
 * invites scoped overrides of `.btn-primary` / `.text-input`, and `global.css` and
 * `views.css` play the same role for the app shell and the view chrome. A collision where
 * one side is a base sheet is therefore a deliberate local override, not a name clash —
 * the component knows it is speaking about a shared class.
 */
const BASE_STYLESHEETS = [
  'src/renderer/src/styles/shared.css',
  'src/renderer/src/styles/global.css',
  'src/renderer/src/views/views.css'
]

/**
 * highlight.js token classes. `FileEditor.css` and `Markdown.css` both dress the same
 * third-party output; the names are fixed by the library, so neither file can scope them
 * away and both are expected to define them. Exempt by prefix rather than by listing 25
 * near-identical entries that would only ever grow.
 */
const EXEMPT_PREFIXES = ['hljs-']

/**
 * Recorded debt — NOT approval.
 *
 * Every entry below is a real bare-class collision that predates this guard. They are
 * listed so the test can fail on anything NEW while still running green today. The right
 * move when you next touch one of these files is to rename the loser (scope it to its
 * component, e.g. `.projects-peek`) and delete the line from this list. The list should
 * only ever get shorter; a change that lengthens it is the mistake this file exists to
 * stop.
 *
 * Format: `class :: <every file that defines it bare>`, sorted, so that a third file
 * joining an existing collision also fails rather than hiding behind the entry.
 */
const BASELINE = [
  'account-dot :: src/renderer/src/components/AccountPicker.css | src/renderer/src/components/AccountsModal.css',
  'account-picker-btn :: src/renderer/src/components/AccountPicker.css | src/renderer/src/views/PlannerView.css | src/renderer/src/views/SprintBoard.css',
  'assist-runwith-field :: src/renderer/src/views/PlannerView.css | src/renderer/src/views/SprintBoard.css',
  'cc-row-tag-btn :: src/renderer/src/components/SessionTags.css | src/renderer/src/views/ProjectsView.css',
  'diff-view :: src/renderer/src/components/DiffView.css | src/renderer/src/components/MessageBubble.css',
  'field-hint :: src/renderer/src/components/AccountsModal.css | src/renderer/src/components/SettingsModal.css',
  'model-picker-btn :: src/renderer/src/components/ModelPicker.css | src/renderer/src/views/PlannerView.css | src/renderer/src/views/SprintBoard.css',
  'peek :: src/renderer/src/components/SessionPeek.css | src/renderer/src/views/ProjectsView.css',
  'planner-label :: src/renderer/src/views/PlannerView.css | src/renderer/src/views/SprintBoard.css',
  'tag-chips :: src/renderer/src/components/SessionTags.css | src/renderer/src/views/ProjectsView.css',
  'tag-editor :: src/renderer/src/components/SessionTags.css | src/renderer/src/views/ProjectsView.css',
  'task-del :: src/renderer/src/views/PlannerView.css | src/renderer/src/views/SprintBoard.css'
]

function listStylesheets(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listStylesheets(full, out)
    else if (entry.name.endsWith('.css')) out.push(full)
  }
  return out
}

/** Repo-relative, forward slashes, so failures read the same on Windows and CI. */
function repoPath(full: string): string {
  return 'src/renderer/' + path.relative(RENDERER_DIR, full).split(path.sep).join('/')
}

/**
 * The bare classes a stylesheet defines.
 *
 * "Bare" means the selector's last compound piece is a lone class with nothing else on it:
 * `.peek` counts, `.project-row.active`, `.peek .title` and `div.peek` do not. That
 * distinction is the whole point of the check — a naive "same class in two files" scan
 * flags ~90 modifiers like `.active` / `.danger` / `.done` that only ever appear composed
 * with an owning class and can never collide. A guard that cries wolf gets deleted, and
 * then the rule is gone.
 */
function bareClasses(css: string): Set<string> {
  const found = new Set<string>()
  // Comments first: they contain braces and example selectors (shared.css's header alone
  // would otherwise register `.badge` and `.btn-primary` as definitions).
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '')
  // Each `<selectors> { <declarations> }`. Because the selector part cannot contain a
  // brace, an at-rule's own header (`@media ...{`) never matches, while the rules nested
  // inside it match normally — which is what we want, a nested rule collides just as hard.
  const rules = /([^{}]+)\{[^{}]*\}/g
  let match: RegExpExecArray | null
  while ((match = rules.exec(stripped))) {
    const selectors = match[1].trim()
    // `@media`, `@keyframes`, `@supports` headers and `:root` blocks define no classes.
    if (!selectors || selectors.includes('@')) continue
    for (const group of selectors.split(',')) {
      const compounds = group.trim().split(/[\s>+~]+/).filter(Boolean)
      const last = compounds[compounds.length - 1]
      if (!last) continue
      // `.peek:hover`, `.peek::after`, `.peek:not(.x)` all still define `.peek`.
      const bare = /^\.([A-Za-z0-9_-]+)$/.exec(last.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ''))
      if (bare) found.add(bare[1])
    }
  }
  return found
}

/** `class :: file | file`, the same shape as BASELINE. */
function collisions(): string[] {
  const owners = new Map<string, Set<string>>()
  for (const file of listStylesheets(RENDERER_DIR)) {
    const rel = repoPath(file)
    for (const cls of bareClasses(fs.readFileSync(file, 'utf8'))) {
      if (!owners.has(cls)) owners.set(cls, new Set())
      owners.get(cls)!.add(rel)
    }
  }
  const out: string[] = []
  for (const [cls, files] of owners) {
    if (files.size < 2) continue
    if (EXEMPT_PREFIXES.some((p) => cls.startsWith(p))) continue
    if ([...files].some((f) => BASE_STYLESHEETS.includes(f))) continue
    out.push(`${cls} :: ${[...files].sort().join(' | ')}`)
  }
  return out.sort()
}

describe('CSS class scoping (convention 6)', () => {
  // The failure this catches: a second stylesheet defining a bare class another file
  // already owns — the `.session-row` mistake, which restyled every chat row in the app
  // from a file that never mentioned chat.
  it('defines no bare class in two stylesheets outside the recorded baseline', () => {
    const unexpected = collisions().filter((c) => !BASELINE.includes(c))
    expect(
      unexpected,
      unexpected.length
        ? 'These bare CSS classes are each defined in more than one stylesheet, and every ' +
          'stylesheet is bundled into one global sheet — so they overwrite each other ' +
          'app-wide:\n  ' +
          unexpected.join('\n  ') +
          '\nScope the new one to its component (rename it, or nest it under an owning ' +
          'class). Do not add it to BASELINE — that list is for debt that predates the ' +
          'guard, and it is meant to shrink.'
        : undefined
    ).toEqual([])
  })

  // The failure this catches: BASELINE turning into permanent cover. Once a collision is
  // actually fixed, its line has to go, or the list stops describing anything and the
  // next person reads it as a list of blessed names.
  it('keeps no stale entries in the baseline', () => {
    const actual = collisions()
    const stale = BASELINE.filter((entry) => !actual.includes(entry))
    expect(
      stale,
      stale.length
        ? 'These BASELINE entries no longer match a real collision:\n  ' +
          stale.join('\n  ') +
          '\nIf you fixed one, delete its line (thank you). If a file list changed, ' +
          'update the line to the files that collide now — see the failure above for the ' +
          'current set.'
        : undefined
    ).toEqual([])
  })

  // A sanity check on the scanner itself: if a refactor moves the stylesheets, the two
  // assertions above would pass on an empty file set and quietly guard nothing.
  it('actually found the stylesheets', () => {
    const sheets = listStylesheets(RENDERER_DIR)
    expect(sheets.length, `no .css files found under ${RENDERER_DIR}`).toBeGreaterThan(20)
  })
})
