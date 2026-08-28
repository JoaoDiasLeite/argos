import type { MemoryGap, MemoryLayer, MemoryLayerId } from './memory-diagnostic'

/**
 * The judgement half of the memory diagnostic: given text that has already been read
 * off disk, decide what the three layers hold, what is missing, and what is broken.
 *
 * Split out because this is the half worth testing — every rule below is a call on
 * whether something is a defect or merely an absence, and getting that call wrong is
 * how a report starts crying wolf about a project that is perfectly healthy.
 *
 * `import type` is erased at compile time, so this module stays loadable in a plain
 * test process even though memory-diagnostic.ts reaches the filesystem at load.
 */

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** One of the two single-file layers, as read (or as failed to read). */
export interface LayerInput {
  path: string
  exists: boolean
  text: string
  bytes: number
  /** Set when the file is there but could not be read. */
  error?: string
}

/** One `.md` file in the memory directory, `MEMORY.md` included. */
export interface MemoryFileInput {
  /** Base name, e.g. `gemini-provider-is-antigravity.md`. */
  file: string
  text: string
  bytes: number
  error?: string
}

export interface MemoriesInput {
  path: string
  exists: boolean
  /** `MEMORY.md`, when it is there. */
  index?: MemoryFileInput
  /** Every other `.md` file in the directory. */
  files: MemoryFileInput[]
  error?: string
}

export interface DiagnosisInput {
  global: LayerInput
  /** Absent when the caller named no project. */
  project?: LayerInput
  /**
   * Absent when the caller named no project — for the same reason `project` is. The
   * memory directory is per-project and derived from the project's own path, so with
   * no project there is no directory this could be about. Reporting one anyway meant
   * pointing at `~/.claude/projects`, which exists, and calling it missing.
   */
  memories?: MemoriesInput
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/** The four kinds Claude Code writes into a memory's `metadata.type`. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface Frontmatter {
  /** Whether a `---` delimited block was there at all. */
  present: boolean
  name?: string
  description?: string
  /** `metadata.type`, verbatim — validating it is findGaps' job, not the parser's. */
  type?: string
  /** Everything after the block (the whole text when there was no block). */
  body: string
}

function unquote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'")
  }
  return v
}

/**
 * The YAML header of a memory file. Deliberately a line reader rather than a YAML
 * parser: the shape Claude Code writes is fixed (`name`, `description`, and a nested
 * `metadata` block), and a real parser would drag a dependency in for three keys.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalised = text.replace(/^﻿/, '')
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalised)
  if (!match) return { present: false, body: normalised }

  const block = match[1]
  const body = normalised.slice(match[0].length)
  const out: Frontmatter = { present: true, body }
  let inMetadata = false

  for (const raw of block.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const indented = /^\s/.test(raw)
    const line = raw.trim()
    if (!indented) inMetadata = false

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const [, key, rest] = kv

    if (!indented && key === 'metadata') {
      inMetadata = true
      continue
    }
    if (inMetadata) {
      if (key === 'type' && rest.trim()) out.type = unquote(rest)
      continue
    }
    if (key === 'name' && rest.trim()) out.name = unquote(rest)
    if (key === 'description' && rest.trim()) out.description = unquote(rest)
  }

  return out
}

export interface IndexParse {
  /** File names the index links to, in order, deduplicated. */
  pointers: string[]
  /**
   * Lines that are neither a pointer, a heading, nor blank — the index is a list of
   * one-line pointers, so anything else in it is a memory hiding where nothing loads
   * it as one.
   */
  extraLines: string[]
}

/** `[Title](file.md)` targets in `MEMORY.md`, plus whatever else the file holds. */
export function parseIndexPointers(text: string): IndexParse {
  const pointers: string[] = []
  const seen = new Set<string>()
  const extraLines: string[] = []

  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // A title for the index is not content in it.
    if (line.startsWith('#')) continue

    // Strip a bullet marker so `- [a](b.md)` and `[a](b.md)` read the same.
    const item = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '')
    const link = /^\[[^\]]*\]\(([^)]+)\)/.exec(item)
    if (!link) {
      extraLines.push(line)
      continue
    }
    let target = link[1].trim().split('#')[0]
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
      // An external link is not a pointer at a memory file.
      extraLines.push(line)
      continue
    }
    try {
      target = decodeURIComponent(target)
    } catch {
      // Leave it as written; a name we cannot decode is still the name to report.
    }
    if (target && !seen.has(target)) {
      seen.add(target)
      pointers.push(target)
    }
  }

  return { pointers, extraLines }
}

/** `[[name]]` targets in a memory body, trimmed and deduplicated. */
export function parseWikiLinks(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of text.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const name = m[1].trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  return out
}

// ─── Layers ───────────────────────────────────────────────────────────────────

const LABELS: Record<MemoryLayerId, string> = {
  global: 'Global CLAUDE.md',
  project: 'Project CLAUDE.md',
  memories: 'Project memories'
}

export function layersOf(input: DiagnosisInput): MemoryLayer[] {
  const layers: MemoryLayer[] = [
    {
      id: 'global',
      label: LABELS.global,
      path: input.global.path,
      exists: input.global.exists,
      bytes: input.global.bytes
    }
  ]
  if (input.project) {
    layers.push({
      id: 'project',
      label: LABELS.project,
      path: input.project.path,
      exists: input.project.exists,
      bytes: input.project.bytes
    })
  }
  if (input.memories) {
    const all = [...(input.memories.index ? [input.memories.index] : []), ...input.memories.files]
    layers.push({
      id: 'memories',
      label: LABELS.memories,
      path: input.memories.path,
      exists: input.memories.exists,
      bytes: all.reduce((sum, f) => sum + f.bytes, 0),
      // MEMORY.md is the index, not a memory — counting it would say a directory
      // holding nothing but an empty index holds one fact.
      files: input.memories.files.length
    })
  }
  return layers
}

// ─── Gaps ─────────────────────────────────────────────────────────────────────

function fileGaps(layer: LayerInput, id: 'global' | 'project', what: string): MemoryGap[] {
  const gaps: MemoryGap[] = []
  if (layer.error) {
    gaps.push({ layer: id, severity: 'warn', message: `${layer.path} could not be read: ${layer.error}` })
    return gaps
  }
  if (!layer.exists) {
    gaps.push({ layer: id, severity: 'info', message: `No ${layer.path} — ${what}` })
    return gaps
  }
  if (!layer.text.trim()) {
    gaps.push({ layer: id, severity: 'info', message: `${layer.path} exists but is empty.` })
  }
  return gaps
}

/**
 * Every rule the report makes, in one place.
 *
 * The severity split is the whole point: `warn` is something actually broken —
 * an index pointing at a file that is not there, a memory nothing loads, a header
 * Claude Code cannot read. `info` is something merely absent, which for a young
 * project is the normal state and must not read as a fault.
 */
export function findGaps(input: DiagnosisInput): MemoryGap[] {
  const gaps: MemoryGap[] = []

  gaps.push(
    ...fileGaps(
      input.global,
      'global',
      'instructions meant for every project have nowhere to live.'
    )
  )
  if (input.project) {
    gaps.push(
      ...fileGaps(
        input.project,
        'project',
        'the repo carries no instructions of its own for Claude Code.'
      )
    )
  }

  const mem = input.memories
  if (!mem) return gaps
  if (mem.error) {
    gaps.push({ layer: 'memories', severity: 'warn', message: `${mem.path} could not be read: ${mem.error}` })
    return gaps
  }
  if (!mem.exists) {
    gaps.push({
      layer: 'memories',
      severity: 'info',
      message: `No memory directory at ${mem.path} yet — Claude Code creates it the first time it writes a memory for this project.`
    })
    return gaps
  }

  const index = mem.index
  if (!index) {
    gaps.push(
      mem.files.length > 0
        ? {
            layer: 'memories',
            severity: 'warn',
            message: `${mem.files.length} memory file(s) sit in ${mem.path} with no MEMORY.md index. The index is what gets loaded into context, so none of them is visible to Claude Code.`
          }
        : {
            layer: 'memories',
            severity: 'info',
            message: `${mem.path} holds no memories yet.`
          }
    )
  } else if (index.error) {
    gaps.push({ layer: 'memories', severity: 'warn', message: `MEMORY.md could not be read: ${index.error}` })
  } else if (!index.text.trim()) {
    gaps.push({ layer: 'memories', severity: 'info', message: 'MEMORY.md is empty.' })
  }

  const parsedIndex = index && !index.error ? parseIndexPointers(index.text) : null
  const pointers = parsedIndex ? parsedIndex.pointers : []

  if (parsedIndex && parsedIndex.extraLines.length > 0) {
    gaps.push({
      layer: 'memories',
      severity: 'info',
      message: `MEMORY.md holds ${parsedIndex.extraLines.length} line(s) that are not pointers. It is an index, not a store — move that content into a memory file of its own.`
    })
  }

  const present = new Set(mem.files.map((f) => f.file))
  for (const target of pointers) {
    if (!present.has(target)) {
      gaps.push({
        layer: 'memories',
        severity: 'warn',
        message: `MEMORY.md points at ${target}, which is not in the memory directory.`
      })
    }
  }

  if (parsedIndex) {
    const pointedAt = new Set(pointers)
    for (const f of mem.files) {
      if (!pointedAt.has(f.file)) {
        gaps.push({
          layer: 'memories',
          severity: 'warn',
          message: `${f.file} is not listed in MEMORY.md, so nothing loads it into context.`
        })
      }
    }
  }

  // Every name a memory answers to. A file with no `name` in its header still
  // answers to its own base name, so a link to it is not dangling.
  const names = new Set<string>()
  for (const f of mem.files) {
    const fm = parseFrontmatter(f.text)
    if (fm.name) names.add(fm.name)
    names.add(f.file.replace(/\.md$/i, ''))
  }

  for (const f of mem.files) {
    if (f.error) {
      gaps.push({ layer: 'memories', severity: 'warn', message: `${f.file} could not be read: ${f.error}` })
      continue
    }
    const fm = parseFrontmatter(f.text)
    if (!fm.present) {
      gaps.push({
        layer: 'memories',
        severity: 'warn',
        message: `${f.file} has no frontmatter block, so it carries no name, description or type.`
      })
    } else {
      const missing: string[] = []
      if (!fm.name) missing.push('name')
      if (!fm.description) missing.push('description')
      if (!fm.type) missing.push('metadata.type')
      if (missing.length > 0) {
        gaps.push({
          layer: 'memories',
          severity: 'warn',
          message: `${f.file} is missing required frontmatter: ${missing.join(', ')}.`
        })
      }
      if (fm.type && !(MEMORY_TYPES as readonly string[]).includes(fm.type)) {
        gaps.push({
          layer: 'memories',
          severity: 'warn',
          message: `${f.file} has metadata.type "${fm.type}", which is not one of ${MEMORY_TYPES.join(', ')}.`
        })
      }
    }

    for (const link of parseWikiLinks(fm.body)) {
      if (!names.has(link)) {
        // Not a defect. The convention here is that a link to a memory nobody has
        // written yet is exactly how you mark one worth writing.
        gaps.push({
          layer: 'memories',
          severity: 'info',
          message: `${f.file} links to [[${link}]], which no memory answers to yet.`
        })
      }
    }
  }

  return gaps
}

// ─── Score ────────────────────────────────────────────────────────────────────

const PRESENCE_POOL = 60
const INTEGRITY_POOL = 40
const WARN_COST = 10
const INFO_COST = 3

/**
 * 0-100, in two parts.
 *
 * Presence is 60 points split evenly across the layers actually reported (two when
 * no project was named, three when one was): a layer with content takes its whole
 * share, one that exists but is empty takes half, an absent one takes none. Presence
 * only ever adds, so a layer being there can never score below the same layer gone.
 *
 * Integrity is the other 40, starting full and spent on what was found: 10 per warn,
 * 3 per info — a defect always costs more than an absence, and the two pools are
 * independent, so the ordering holds whichever way the report moves.
 */
export function scoreOf(layers: MemoryLayer[], gaps: MemoryGap[]): number {
  if (layers.length === 0) return 0
  const share = PRESENCE_POOL / layers.length
  let presence = 0
  for (const l of layers) {
    if (!l.exists) continue
    presence += l.bytes > 0 ? share : share / 2
  }
  const warns = gaps.filter((g) => g.severity === 'warn').length
  const infos = gaps.filter((g) => g.severity === 'info').length
  const integrity = Math.max(0, INTEGRITY_POOL - warns * WARN_COST - infos * INFO_COST)
  return Math.max(0, Math.min(100, Math.round(presence + integrity)))
}
