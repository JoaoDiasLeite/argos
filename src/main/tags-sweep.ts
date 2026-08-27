import * as fs from 'fs'
import * as path from 'path'
import { getSources, safeSessionPath, ClaudeSource } from './claude-data'
import { readEffectiveTags, writeSessionTags } from './tags'

/**
 * Cross-source tag operations — everything that has to look at more than one
 * transcript. Split from tags.ts so the read/write primitives stay free of source
 * resolution (and of electron, so they can be tested against a real file).
 */

export interface TaggedSession {
  file: string
  sourceId: string
  encodedDir: string
  sessionId: string
  tags: string[]
}

/** Every directory that can hold a transcript, across every source. */
async function allSessionDirs(): Promise<{ src: ClaudeSource; dir: string; encodedDir: string }[]> {
  const out: { src: ClaudeSource; dir: string; encodedDir: string }[] = []
  for (const src of await getSources()) {
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(src.projectsDir, { withFileTypes: true })
    } catch {
      // A source whose projects dir is gone contributes nothing, and an offline WSL
      // distro looks exactly like this — so this failure is expected and skipped,
      // unlike the per-transcript read below.
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      out.push({ src, dir: path.join(src.projectsDir, entry.name), encodedDir: entry.name })
    }
  }
  return out
}

/**
 * Every session whose effective tag set carries `name`.
 *
 * One sweep serves all three vocabulary verbs — cascade delete, merge, and the count
 * the confirmations show. Three separate loops would eventually disagree about what
 * "the tag is applied" means, and the count that talks the user into a destructive
 * action has to be the same one that action uses.
 */
export async function scanSessionsWithTag(name: string): Promise<TaggedSession[]> {
  const hits: TaggedSession[] = []
  for (const { src, dir, encodedDir } of await allSessionDirs()) {
    let files: string[]
    try {
      files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const f of files) {
      const file = path.join(dir, f)
      let tags: string[]
      try {
        tags = await readEffectiveTags(file)
      } catch {
        // One unreadable transcript must not abort the sweep. It is counted as a
        // failure by the caller instead, which is what stops a partial sweep from
        // completing a destructive operation.
        continue
      }
      if (tags.includes(name)) {
        hits.push({ file, sourceId: src.id, encodedDir, sessionId: f.replace(/\.jsonl$/, ''), tags })
      }
    }
  }
  return hits
}

/** How many sessions carry `name`. Feeds the destructive confirmations. */
export async function countSessionsWithTag(name: string): Promise<number> {
  return (await scanSessionsWithTag(name)).length
}

/**
 * Apply `change` to the tag set of every session carrying `name`.
 *
 * Returns how many were rewritten and how many failed. The caller decides what a
 * partial result means — for the vocabulary verbs it means the registry is left
 * alone, so a tag that is still applied somewhere never loses its entry.
 */
export async function rewriteTagAcrossSessions(
  name: string,
  change: (tags: string[]) => string[]
): Promise<{ changed: number; failed: number }> {
  let changed = 0
  let failed = 0
  for (const hit of await scanSessionsWithTag(name)) {
    try {
      await writeSessionTags(hit.file, hit.sessionId, change(hit.tags))
      changed++
    } catch {
      failed++
    }
  }
  return { changed, failed }
}

/** Read the tags of one session, addressed the way the renderer addresses it. */
export async function tagsForSession(
  sourceId: string,
  encodedDir: string,
  sessionId: string
): Promise<string[]> {
  const file = await safeSessionPath(sourceId, encodedDir, sessionId)
  if (!file) return []
  try {
    return await readEffectiveTags(file)
  } catch {
    return []
  }
}
