import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  appendTitle,
  deleteTranscript,
  InvalidTitleError,
  MAX_TITLE,
  moveTranscript,
  normalizeTitle
} from './session-files'

let dir: string
const made: string[] = []

function write(rel: string, body = '{"type":"user","message":{"content":"hi"}}\n'): string {
  const p = path.join(dir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf-8')
  return p
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-lifecycle-'))
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

describe('moveTranscript', () => {
  it('moves the file and creates the destination directory', async () => {
    const from = write('a.jsonl')
    const to = path.join(dir, 'archived', 'a.jsonl')
    expect(await moveTranscript(from, to)).toEqual({ ok: true })
    expect(fs.existsSync(from)).toBe(false)
    expect(fs.existsSync(to)).toBe(true)
  })

  it('carries the contents across untouched', async () => {
    const body = '{"type":"user"}\n{"type":"custom-tags","tags":["ui"]}\n'
    const from = write('a.jsonl', body)
    const to = path.join(dir, 'archived', 'a.jsonl')
    await moveTranscript(from, to)
    expect(fs.readFileSync(to, 'utf-8')).toBe(body)
  })

  it('refuses rather than overwriting an existing destination', async () => {
    // The same id at both ends means something else put it there. Overwriting would
    // destroy a conversation to tidy a directory.
    const from = write('a.jsonl', 'FROM\n')
    write('archived/a.jsonl', 'TO\n')
    const to = path.join(dir, 'archived', 'a.jsonl')
    expect(await moveTranscript(from, to)).toEqual({ ok: false, error: 'exists' })
    expect(fs.readFileSync(to, 'utf-8')).toBe('TO\n')
    expect(fs.existsSync(from)).toBe(true)
  })

  it('reports a missing source instead of creating an empty destination', async () => {
    const to = path.join(dir, 'archived', 'gone.jsonl')
    expect(await moveTranscript(path.join(dir, 'gone.jsonl'), to)).toEqual({
      ok: false,
      error: 'not-found'
    })
    expect(fs.existsSync(to)).toBe(false)
  })

  it('is a no-op when both ends are the same path', async () => {
    const f = write('a.jsonl')
    expect(await moveTranscript(f, f)).toEqual({ ok: true })
    expect(fs.existsSync(f)).toBe(true)
  })

  it('round-trips: archive then unarchive lands back where it started', async () => {
    const active = path.join(dir, 'a.jsonl')
    const archived = path.join(dir, 'archived', 'a.jsonl')
    write('a.jsonl', 'BODY\n')
    await moveTranscript(active, archived)
    await moveTranscript(archived, active)
    expect(fs.readFileSync(active, 'utf-8')).toBe('BODY\n')
    expect(fs.existsSync(archived)).toBe(false)
  })
})

describe('deleteTranscript', () => {
  it('removes the file', async () => {
    const f = write('a.jsonl')
    expect(await deleteTranscript(f)).toEqual({ ok: true })
    expect(fs.existsSync(f)).toBe(false)
  })

  it('reports a file that was already gone', async () => {
    expect(await deleteTranscript(path.join(dir, 'nope.jsonl'))).toEqual({
      ok: false,
      error: 'not-found'
    })
  })
})

describe('normalizeTitle', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeTitle('  a   b \n c ')).toBe('a b c')
  })

  it('rejects an empty or blank title', () => {
    expect(() => normalizeTitle('')).toThrow(InvalidTitleError)
    expect(() => normalizeTitle('   ')).toThrow(InvalidTitleError)
    expect(() => normalizeTitle(null)).toThrow(InvalidTitleError)
  })

  it('rejects a paste of something else', () => {
    expect(() => normalizeTitle('x'.repeat(MAX_TITLE + 1))).toThrow(InvalidTitleError)
    expect(normalizeTitle('x'.repeat(MAX_TITLE))).toHaveLength(MAX_TITLE)
  })
})

describe('appendTitle', () => {
  it('appends rather than rewriting, leaving the conversation intact', async () => {
    const body = '{"type":"user","message":{"content":"hi"}}\n'
    const f = write('a.jsonl', body)
    expect(await appendTitle(f, 'sid-1', 'A better name')).toEqual({ ok: true })
    const after = fs.readFileSync(f, 'utf-8')
    expect(after.startsWith(body)).toBe(true)
    expect(JSON.parse(after.trimEnd().split('\n')[1])).toEqual({
      type: 'custom-title',
      customTitle: 'A better name',
      sessionId: 'sid-1'
    })
  })

  it('writes nothing when the title is invalid', async () => {
    const f = write('a.jsonl', 'BODY\n')
    const res = await appendTitle(f, 'sid-1', '   ')
    expect(res.ok).toBe(false)
    expect(fs.readFileSync(f, 'utf-8')).toBe('BODY\n')
  })

  it('reports a missing file', async () => {
    expect(await appendTitle(path.join(dir, 'gone.jsonl'), 'sid-1', 'x')).toEqual({
      ok: false,
      error: 'not-found'
    })
  })

  it('lets a later rename win, which is how the format is read back', async () => {
    const f = write('a.jsonl', '')
    await appendTitle(f, 'sid-1', 'first')
    await appendTitle(f, 'sid-1', 'second')
    const lines = fs.readFileSync(f, 'utf-8').trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]).customTitle).toBe('second')
  })
})
