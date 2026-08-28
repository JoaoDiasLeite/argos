import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { encodePath } from './claude-data'
import { findGaps, layersOf, scoreOf } from './memory-diagnostic-pure'
import type { DiagnosisInput, LayerInput, MemoryFileInput, MemoriesInput } from './memory-diagnostic-pure'

/**
 * What Claude Code's memory holds for a project, across the three layers that reach a
 * conversation: the global CLAUDE.md, the project's own CLAUDE.md, and the per-project
 * memory directory with its MEMORY.md index.
 *
 * Read-only by construction. There is no write counterpart to any of this and there
 * must not be one: the report names the file a gap is in, and closing it is the user's
 * edit to make. Rewriting someone's memory on their behalf is how a memory stops being
 * theirs.
 *
 * This module is only the reading — resolve three paths, stat, read, hand it all to
 * memory-diagnostic-pure.ts, stamp the time. Every rule about what counts as a gap and
 * what it costs lives there, where it can be tested without a filesystem.
 */

// ─── Types ────────────────────────────────────────────────────────────────────
// Mirror of the "Memory diagnostics" block in src/renderer/src/types.ts — keep both
// in sync.

export type MemoryLayerId = 'global' | 'project' | 'memories'

export interface MemoryLayer {
  id: MemoryLayerId
  label: string
  path: string
  exists: boolean
  /** Bytes for the two file layers; total bytes across the directory for `memories`. */
  bytes: number
  /** Files in the memory directory. Undefined for the single-file layers. */
  files?: number
}

export interface MemoryGap {
  layer: MemoryLayerId
  /** `warn` is something actually broken; `info` is something merely absent. */
  severity: 'info' | 'warn'
  message: string
}

export interface MemoryReport {
  projectPath?: string
  layers: MemoryLayer[]
  gaps: MemoryGap[]
  /** 0-100, derived from the layers present and the gaps found. */
  score: number
  checkedAt: number
}

// ─── Reading ──────────────────────────────────────────────────────────────────

const INDEX_FILE = 'MEMORY.md'

function reason(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  return err?.code ?? (e instanceof Error ? e.message : String(e))
}

function missing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** One CLAUDE.md. A file that is not there is an absence, never a throw. */
function readLayer(p: string): LayerInput {
  try {
    const st = fs.statSync(p)
    if (!st.isFile()) return { path: p, exists: false, text: '', bytes: 0 }
    return { path: p, exists: true, text: fs.readFileSync(p, 'utf8'), bytes: st.size }
  } catch (e) {
    if (missing(e)) return { path: p, exists: false, text: '', bytes: 0 }
    // There but unreadable — a gap in the report, not a rejected promise.
    return { path: p, exists: true, text: '', bytes: 0, error: reason(e) }
  }
}

function readMemoryFile(dir: string, file: string): MemoryFileInput {
  try {
    const full = path.join(dir, file)
    const st = fs.statSync(full)
    return { file, text: fs.readFileSync(full, 'utf8'), bytes: st.size }
  } catch (e) {
    return { file, text: '', bytes: 0, error: reason(e) }
  }
}

function readMemories(dir: string): MemoriesInput {
  let entries: fs.Dirent[]
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) return { path: dir, exists: false, files: [] }
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    if (missing(e)) return { path: dir, exists: false, files: [] }
    return { path: dir, exists: true, files: [], error: reason(e) }
  }

  const names = entries.filter((e) => e.isFile() && /\.md$/i.test(e.name)).map((e) => e.name)
  const indexName = names.find((n) => n.toLowerCase() === INDEX_FILE.toLowerCase())
  return {
    path: dir,
    exists: true,
    index: indexName ? readMemoryFile(dir, indexName) : undefined,
    files: names.filter((n) => n !== indexName).map((n) => readMemoryFile(dir, n))
  }
}

/**
 * The report. `projectPath` is the project's real folder — the same value the projects
 * list shows — and the memory directory is found from it through `encodePath`, which is
 * Claude Code's own encoding of a real path into a directory name.
 *
 * Never throws: this sits directly behind an IPC handler, and a diagnostic that fails
 * to report is worse than one that reports a failure.
 */
export function diagnoseMemory(projectPath?: string): MemoryReport {
  const checkedAt = Date.now()
  try {
    const claudeDir = path.join(os.homedir(), '.claude')
    const projectsDir = path.join(claudeDir, 'projects')

    const input: DiagnosisInput = {
      global: readLayer(path.join(claudeDir, 'CLAUDE.md')),
      project: projectPath ? readLayer(path.join(projectPath, 'CLAUDE.md')) : undefined,
      // Omitted rather than faked when no project was named: the directory is derived
      // from the project's path, so without one there is nothing this layer is about.
      memories: projectPath
        ? readMemories(path.join(projectsDir, encodePath(projectPath), 'memory'))
        : undefined
    }

    const layers = layersOf(input)
    const gaps = findGaps(input)
    return { projectPath, layers, gaps, score: scoreOf(layers, gaps), checkedAt }
  } catch (e) {
    return {
      projectPath,
      layers: [],
      gaps: [{ layer: 'global', severity: 'warn', message: `Memory could not be checked: ${reason(e)}` }],
      score: 0,
      checkedAt
    }
  }
}
