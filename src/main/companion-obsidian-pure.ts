/**
 * The Obsidian export of companion notes (docs/COMPANION_PLAN.md §6.2), without the disk:
 * the file name, the markdown, and which folder inside the vault. companion-obsidian.ts
 * does the writing.
 *
 * An export, not a sync: notes.json stays the truth, each note is written once as
 * `<vault>/<folder>/YYYY-MM-DD-<slug>.md`, and nothing is ever read back from the vault.
 */
import * as path from 'path'
import type { CompanionNote } from './companion-types'

/** The subfolder inside the vault when none is set. */
export const DEFAULT_OBSIDIAN_FOLDER = 'Argos'

/** How long the slug part of a file name gets, in characters. */
const SLUG_MAX = 48

/** Characters Windows refuses in a file or folder name. */
const BAD_NAME = /[<>:"|?*\u0000-\u001f]/

const pad = (n: number): string => String(n).padStart(2, '0')

/** "2026-11-03", local time. */
export function localDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "2026-11-03T14:05", local time: what Obsidian's date properties read. */
export function localMinute(ms: number): string {
  const d = new Date(ms)
  return `${localDay(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The first words of a note as a file-name slug: lower case, accents dropped, anything
 * else a dash, cut at a word under SLUG_MAX. "nota" when nothing is left.
 */
export function slugify(text: string): string {
  const flat = text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!flat) return 'nota'
  if (flat.length <= SLUG_MAX) return flat
  const cut = flat.slice(0, SLUG_MAX + 1)
  const dash = cut.lastIndexOf('-')
  return (dash > 0 ? cut.slice(0, dash) : flat.slice(0, SLUG_MAX)).replace(/-+$/, '')
}

/** `YYYY-MM-DD-<slug>.md`, before any collision suffix. */
export function noteFileName(note: Pick<CompanionNote, 'text' | 'createdAt'>): string {
  return `${localDay(note.createdAt)}-${slugify(note.text)}.md`
}

/** The n-th name to try for `base`: n = 1 is `base` itself, then `-2`, `-3`… before `.md`. */
export function candidateName(base: string, n: number): string {
  if (n <= 1) return base
  return base.replace(/\.md$/, '') + `-${n}.md`
}

/**
 * The note as markdown: frontmatter (`created`, `source`, `tags`, always with `argos`)
 * and the text. Values are double-quoted, so a tag with a colon stays one string.
 */
export function noteMarkdown(note: CompanionNote): string {
  const tags = ['argos', ...(note.tags ?? []).map((t) => t.trim().replace(/^#/, '')).filter(Boolean)]
  const unique = [...new Set(tags)]
  const lines = [
    '---',
    `created: ${localMinute(note.createdAt)}`,
    `source: ${note.source}`,
    'tags:',
    ...unique.map((t) => `  - ${JSON.stringify(t)}`),
    '---',
    '',
    note.text.trim(),
    ''
  ]
  return lines.join('\n')
}

/**
 * The subfolder setting cleaned up: back slashes to forward, no leading or trailing
 * slash, '' for the vault's root. null for anything that would leave the vault (`..`,
 * a drive or an absolute path) or a name Windows refuses.
 */
export function cleanSubfolder(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/')
  if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith('//')) return null
  const parts = trimmed.split('/').map((p) => p.trim()).filter(Boolean)
  for (const p of parts) {
    if (p === '.' || p === '..' || BAD_NAME.test(p) || /[. ]$/.test(p)) return null
  }
  return parts.join('/')
}

/**
 * The folder notes go to, or null when the export is off (no vault) or the settings
 * can't be used: a relative vault path, or a subfolder cleanSubfolder refuses.
 */
export function exportDir(vault: string, subfolder: string): string | null {
  if (!vault || !path.isAbsolute(vault)) return null
  const folder = cleanSubfolder(subfolder)
  if (folder === null) return null
  return folder ? path.join(vault, ...folder.split('/')) : path.normalize(vault)
}
