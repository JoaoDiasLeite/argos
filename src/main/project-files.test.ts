import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { countTranscripts, removeEmptyProjectDir, renameDir } from './project-files'

let dir: string
const made: string[] = []

function write(rel: string, body = '{"type":"user","message":{"content":"hi"}}\n'): string {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf-8')
  return p
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-project-'))
  made.push(dir)
})

afterAll(() => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* temp dirs */
    }
  }
})

describe('countTranscripts', () => {
  it('counts active transcripts and ignores anything else in the directory', () => {
    write('a.jsonl')
    write('b.jsonl')
    write('notes.md')
    expect(countTranscripts(dir)).toEqual({ sessions: 2, archived: 0 })
  })

  it('counts the archived subdirectory separately', () => {
    write('a.jsonl')
    write('archived/old.jsonl')
    write('archived/older.jsonl')
    expect(countTranscripts(dir)).toEqual({ sessions: 1, archived: 2 })
  })

  it('reads zero rather than failing when the directory does not exist', () => {
    // `archived/` only appears after the first archive, and a project directory can
    // be gone by the time we look.
    expect(countTranscripts(path.join(dir, 'nope'))).toEqual({ sessions: 0, archived: 0 })
  })
})

describe('removeEmptyProjectDir', () => {
  it('reports a directory that is already gone', async () => {
    expect(await removeEmptyProjectDir(path.join(dir, 'nope'))).toEqual({
      ok: false,
      error: 'not-found'
    })
  })

  it('refuses while an active transcript is there, and leaves it in place', async () => {
    write('a.jsonl')
    expect(await removeEmptyProjectDir(dir)).toEqual({
      ok: false,
      error: 'not-empty',
      sessions: 1,
      archived: 0
    })
    expect(fs.existsSync(path.join(dir, 'a.jsonl'))).toBe(true)
  })

  it('refuses when only an archived transcript is left', async () => {
    // Archived is still a conversation; the delete exists to clear empty projects.
    write('archived/old.jsonl')
    expect(await removeEmptyProjectDir(dir)).toEqual({
      ok: false,
      error: 'not-empty',
      sessions: 0,
      archived: 1
    })
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('refuses over a transcript in an unexpected nested subdirectory', async () => {
    // The rescan is recursive precisely because the two known directories would not
    // have seen this one — and the counts it reports are still the two-directory
    // ones, which is what makes the message honest about being only a summary.
    write('backup/2024/stray.jsonl')
    expect(await removeEmptyProjectDir(dir)).toEqual({
      ok: false,
      error: 'not-empty',
      sessions: 0,
      archived: 0
    })
    expect(fs.existsSync(path.join(dir, 'backup', '2024', 'stray.jsonl'))).toBe(true)
  })

  it('removes a directory holding only non-transcript leftovers', async () => {
    write('.DS_Store', 'junk')
    fs.mkdirSync(path.join(dir, 'archived'), { recursive: true })
    expect(await removeEmptyProjectDir(dir)).toEqual({ ok: true })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('removes a truly empty directory', async () => {
    expect(await removeEmptyProjectDir(dir)).toEqual({ ok: true })
    expect(fs.existsSync(dir)).toBe(false)
  })
})

describe('renameDir', () => {
  it('moves the whole tree, contents intact', async () => {
    write('sub/a.jsonl', 'one\n')
    expect(await renameDir(path.join(dir, 'sub'), path.join(dir, 'renamed'))).toEqual({ ok: true })
    expect(fs.existsSync(path.join(dir, 'sub'))).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'renamed', 'a.jsonl'), 'utf-8')).toBe('one\n')
  })

  it('reports a source that is not there', async () => {
    expect(await renameDir(path.join(dir, 'nope'), path.join(dir, 'other'))).toEqual({
      ok: false,
      error: 'not-found'
    })
  })

  it('refuses an existing destination rather than merging into it', async () => {
    // Two project trees interleaved is not something a rename can undo.
    write('a/one.jsonl')
    write('b/two.jsonl')
    const res = await renameDir(path.join(dir, 'a'), path.join(dir, 'b'))
    expect(res.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, 'a', 'one.jsonl'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'b', 'two.jsonl'))).toBe(true)
  })

  it('fails rather than creating the destination parent', async () => {
    // The parent is checked upstream; inventing it here would file the project
    // somewhere the user never named.
    write('a/one.jsonl')
    const res = await renameDir(path.join(dir, 'a'), path.join(dir, 'missing', 'deep', 'a'))
    expect(res.ok).toBe(false)
    expect(fs.existsSync(path.join(dir, 'a', 'one.jsonl'))).toBe(true)
  })
})
