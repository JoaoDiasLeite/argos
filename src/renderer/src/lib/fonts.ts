// The curated font list, and the check for whether a family is actually installed.
//
// Curated rather than enumerated: Electron cannot list system fonts from the renderer
// without a native module, and even where a full list is available it is the wrong
// thing to show — a picker of four hundred families (half of them icon fonts and
// Adobe leftovers) is not a choice, it is a chore. This list is the families Windows 11
// and macOS actually ship, plus the two or three developers install on purpose.

export type FontKind = 'ui' | 'mono'

export interface FontFamily {
  /** Stored in `UiPrefs.fonts`. Stable — renaming one silently resets a user's choice. */
  id: string
  name: string
  /** The full CSS stack written to --font-sans / --font-content / --font-mono. */
  stack: string
  kind: FontKind
}

/** What `--font-sans` is in global.css: the platform's own UI face, whatever it is. */
export const SYSTEM_SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
/** What `--font-mono` is in global.css. */
export const SYSTEM_MONO = "'Menlo', 'Monaco', 'Courier New', monospace"

/**
 * `id: 'system'` is the only entry with no family of its own — it means "write the
 * default stack", and it is always offered because it can never be missing.
 */
export const FONTS: readonly FontFamily[] = [
  { id: 'system', name: 'System default', stack: SYSTEM_SANS, kind: 'ui' },
  { id: 'segoe-ui', name: 'Segoe UI', stack: "'Segoe UI', " + SYSTEM_SANS, kind: 'ui' },
  { id: 'segoe-ui-variable', name: 'Segoe UI Variable', stack: "'Segoe UI Variable Text', 'Segoe UI', " + SYSTEM_SANS, kind: 'ui' },
  { id: 'inter', name: 'Inter', stack: "'Inter', " + SYSTEM_SANS, kind: 'ui' },
  { id: 'sf-pro', name: 'SF Pro', stack: "'SF Pro Text', -apple-system, " + SYSTEM_SANS, kind: 'ui' },
  { id: 'helvetica-neue', name: 'Helvetica Neue', stack: "'Helvetica Neue', Helvetica, Arial, sans-serif", kind: 'ui' },
  { id: 'arial', name: 'Arial', stack: 'Arial, Helvetica, sans-serif', kind: 'ui' },
  { id: 'calibri', name: 'Calibri', stack: "Calibri, 'Segoe UI', sans-serif", kind: 'ui' },
  { id: 'verdana', name: 'Verdana', stack: 'Verdana, Geneva, sans-serif', kind: 'ui' },
  { id: 'tahoma', name: 'Tahoma', stack: 'Tahoma, Geneva, sans-serif', kind: 'ui' },
  { id: 'georgia', name: 'Georgia', stack: "Georgia, 'Times New Roman', serif", kind: 'ui' },
  { id: 'cambria', name: 'Cambria', stack: "Cambria, Georgia, serif", kind: 'ui' },
  { id: 'charter', name: 'Charter', stack: "Charter, Georgia, serif", kind: 'ui' },

  { id: 'system-mono', name: 'System default', stack: SYSTEM_MONO, kind: 'mono' },
  { id: 'cascadia-code', name: 'Cascadia Code', stack: "'Cascadia Code', 'Cascadia Mono', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'cascadia-mono', name: 'Cascadia Mono', stack: "'Cascadia Mono', 'Cascadia Code', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'consolas', name: 'Consolas', stack: "Consolas, 'Cascadia Mono', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'sf-mono', name: 'SF Mono', stack: "'SF Mono', Menlo, " + SYSTEM_MONO, kind: 'mono' },
  { id: 'menlo', name: 'Menlo', stack: "Menlo, Monaco, monospace", kind: 'mono' },
  { id: 'monaco', name: 'Monaco', stack: "Monaco, Menlo, monospace", kind: 'mono' },
  { id: 'jetbrains-mono', name: 'JetBrains Mono', stack: "'JetBrains Mono', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'fira-code', name: 'Fira Code', stack: "'Fira Code', 'Fira Mono', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'source-code-pro', name: 'Source Code Pro', stack: "'Source Code Pro', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'ibm-plex-mono', name: 'IBM Plex Mono', stack: "'IBM Plex Mono', " + SYSTEM_MONO, kind: 'mono' },
  { id: 'lucida-console', name: 'Lucida Console', stack: "'Lucida Console', Monaco, monospace", kind: 'mono' },
  { id: 'courier-new', name: 'Courier New', stack: "'Courier New', Courier, monospace", kind: 'mono' }
]

export function fontById(id: string | undefined): FontFamily | undefined {
  if (!id) return undefined
  return FONTS.find((f) => f.id === id)
}

/**
 * The family name to probe for installation — the first quoted or bare name in the
 * stack, i.e. the one the user is actually asking for. Everything after it is fallback
 * and, by construction, always present.
 */
function primaryFamily(stack: string): string {
  const first = stack.split(',')[0].trim()
  return first.replace(/^['"]|['"]$/g, '')
}

// Measuring costs a canvas and two text layouts per family; the answer cannot change
// while the app is running (installing a font mid-session is not a case worth a cache
// invalidation), so it is worked out once per family and kept.
const installed = new Map<string, boolean>()

let ctx: CanvasRenderingContext2D | null | undefined

function context(): CanvasRenderingContext2D | null {
  if (ctx !== undefined) return ctx
  ctx = document.createElement('canvas').getContext('2d')
  return ctx
}

/**
 * Is this family really on the machine?
 *
 * By measurement, not by `document.fonts.check()`. That API answers "can this font be
 * used", and Chromium answers yes for any family name that resolves through the
 * fallback chain — which is every name, since something always renders. It is the
 * right API for a *web* font that may still be loading and the wrong one for a local
 * family that may not exist. So instead: lay the same string out twice, once asking
 * for `family, <generic>` and once for `<generic>` alone. If the family is missing,
 * the browser fell back to the generic and the two widths are identical to the pixel.
 *
 * Two generics are tried because a family can genuinely have metrics identical to one
 * of them (Monaco and Menlo are close enough to collide on short strings); a real
 * font would have to match both serif and monospace to slip through, which no font does.
 */
export function isFontInstalled(family: string): boolean {
  const cached = installed.get(family)
  if (cached !== undefined) return cached

  const c = context()
  // No canvas (never seen in Electron, possible in a test environment): claim yes.
  // Offering a font that falls back is a cosmetic disappointment; hiding every font
  // because the probe is unavailable leaves the picker empty, which reads as broken.
  if (!c) return true

  // A wide sample with letters whose widths differ most between faces.
  const SAMPLE = 'mmmmmmmmmmlliWWWW@—iiiil1'
  const width = (spec: string): number => {
    c.font = `72px ${spec}`
    return c.measureText(SAMPLE).width
  }

  const quoted = `"${family}"`
  const result = ['monospace', 'serif'].some((generic) => width(`${quoted}, ${generic}`) !== width(generic))
  installed.set(family, result)
  return result
}

/**
 * The families of one kind that this machine can actually render.
 *
 * The whole reason this exists: a picker that lists Cascadia Code on a Mac lets the
 * user pick it, shows it as picked, and renders Menlo. Nothing about that failure is
 * visible, so it has to be prevented at the list.
 */
export function availableFonts(kind: FontKind): FontFamily[] {
  return FONTS.filter((f) => {
    if (f.kind !== kind) return false
    // The system entries are generic stacks, not families — always available.
    if (f.id === 'system' || f.id === 'system-mono') return true
    return isFontInstalled(primaryFamily(f.stack))
  })
}
