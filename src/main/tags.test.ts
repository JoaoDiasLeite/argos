import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { readEffectiveTags, writeSessionTags } from './tags'
import { InvalidTagError } from './tags-pure'

let dir: string

function transcript(body: string): string {
  const p = path.join(dir, 'session.jsonl')
  fs.writeFileSync(p, body, 'utf-8')
  return p
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-tags-'))
})

afterAll(() => {
  try {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true })
  } catch {
    /* temp dirs */
  }
})

describe('readEffectiveTags', () => {
  it('returns the last custom-tags entry, not the first', () => {
    // Same precedence the CLI uses for custom-title. Appending is the only write,
    // so "current" always means "last".
    const f = transcript(
      '{"type":"user"}\n' +
        '{"type":"custom-tags","tags":["ui"]}\n' +
        '{"type":"assistant"}\n' +
        '{"type":"custom-tags","tags":["bug","perf"]}\n'
    )
    return expect(readEffectiveTags(f)).resolves.toEqual(['bug', 'perf'])
  })

  it('is empty for a transcript that was never tagged', () => {
    const f = transcript('{"type":"user"}\n{"type":"assistant"}\n')
    return expect(readEffectiveTags(f)).resolves.toEqual([])
  })

  it('treats an emptied set as emptied, not as absent', () => {
    // Removing the last tag writes [] — falling back to an earlier entry here would
    // make a tag impossible to remove.
    const f = transcript('{"type":"custom-tags","tags":["ui"]}\n{"type":"custom-tags","tags":[]}\n')
    return expect(readEffectiveTags(f)).resolves.toEqual([])
  })

  it('drops non-string members of a hand-written entry', () => {
    const f = transcript('{"type":"custom-tags","tags":["ui",42,null,"bug"]}\n')
    return expect(readEffectiveTags(f)).resolves.toEqual(['ui', 'bug'])
  })

  it('ignores an entry whose tags field is not an array', () => {
    const f = transcript('{"type":"custom-tags","tags":"ui"}\n{"type":"custom-tags","tags":["ok"]}\n')
    return expect(readEffectiveTags(f)).resolves.toEqual(['ok'])
  })
})

describe('writeSessionTags', () => {
  it('appends rather than rewriting, leaving the conversation intact', async () => {
    const body = '{"type":"user","message":{"content":"hi"}}\n'
    const f = transcript(body)
    await writeSessionTags(f, 'sid-1', ['ui'])
    const after = fs.readFileSync(f, 'utf-8')
    expect(after.startsWith(body)).toBe(true)
    expect(after.trimEnd().split('\n')).toHaveLength(2)
  })

  it('normalises before touching the disk', async () => {
    // The regression this guards: with validation in the IPC handler instead of here,
    // the label-rename path built its line by hand and wrote ["ui","ui"].
    const f = transcript('')
    const written = await writeSessionTags(f, 'sid-1', ['  ui  ', 'ui', '', 'bug'])
    expect(written).toEqual(['ui', 'bug'])
    await expect(readEffectiveTags(f)).resolves.toEqual(['ui', 'bug'])
  })

  it('writes nothing when the set is invalid', async () => {
    const f = transcript('{"type":"user"}\n')
    const before = fs.readFileSync(f, 'utf-8')
    await expect(writeSessionTags(f, 'sid-1', ['bad,tag'])).rejects.toThrow(InvalidTagError)
    expect(fs.readFileSync(f, 'utf-8')).toBe(before)
  })

  it('stamps the session id so the line is self-describing', async () => {
    const f = transcript('')
    await writeSessionTags(f, 'sid-42', ['ui'])
    expect(JSON.parse(fs.readFileSync(f, 'utf-8').trim())).toEqual({
      type: 'custom-tags',
      tags: ['ui'],
      sessionId: 'sid-42'
    })
  })

  it('round-trips repeated edits', async () => {
    const f = transcript('')
    await writeSessionTags(f, 'sid-1', ['ui'])
    await writeSessionTags(f, 'sid-1', ['ui', 'bug'])
    await writeSessionTags(f, 'sid-1', ['bug'])
    await expect(readEffectiveTags(f)).resolves.toEqual(['bug'])
    // Every edit is still on disk — append-only means no history is lost.
    expect(fs.readFileSync(f, 'utf-8').trimEnd().split('\n')).toHaveLength(3)
  })

  it('survives a transcript whose last line is a partial write', async () => {
    const f = transcript('{"type":"custom-tags","tags":["ui"]}\n{"type":"assist\n')
    await writeSessionTags(f, 'sid-1', ['bug'])
    await expect(readEffectiveTags(f)).resolves.toEqual(['bug'])
  })
})
