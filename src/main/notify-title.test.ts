import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { tailJsonlEntries } from './jsonl'
import { titleFromTranscript } from './notify-title'

let dir: string

function write(name: string, lines: unknown[]): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8')
  return p
}

const userMsg = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra
})

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-notify-title-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('tailJsonlEntries', () => {
  it('reads a short file whole', async () => {
    const f = write('short.jsonl', [{ n: 1 }, { n: 2 }, { n: 3 }])
    expect((await tailJsonlEntries(f)).map((o) => o.n)).toEqual([1, 2, 3])
  })

  // The window starts mid-line, and half a line either fails to parse or — worse —
  // parses into something that was never written.
  it('drops the fragment the window opened on', async () => {
    const f = write('long.jsonl', [{ n: 1, pad: 'x'.repeat(200) }, { n: 2 }, { n: 3 }])
    const out = await tailJsonlEntries(f, 60)
    expect(out.map((o) => o.n)).toEqual([2, 3])
  })

  it('skips a trailing partial write, like the streaming read does', async () => {
    const f = path.join(dir, 'partial.jsonl')
    fs.writeFileSync(f, '{"n":1}\n{"n":2}\n{"n":3,"broken":\n', 'utf-8')
    expect((await tailJsonlEntries(f)).map((o) => o.n)).toEqual([1, 2])
  })

  it('is empty for an empty file', async () => {
    const f = path.join(dir, 'empty.jsonl')
    fs.writeFileSync(f, '', 'utf-8')
    expect(await tailJsonlEntries(f)).toEqual([])
  })
})

describe('titleFromTranscript', () => {
  // The CLI's own precedence, so a `/rename` in a console shows up in the
  // notification for that conversation.
  it('prefers the owner’s name over the model’s', async () => {
    const f = write('named.jsonl', [
      userMsg('something else entirely'),
      { type: 'ai-title', aiTitle: 'Generated name' },
      { type: 'custom-title', customTitle: 'The name I chose' }
    ])
    expect(await titleFromTranscript(f)).toBe('The name I chose')
  })

  it('takes the last name of each kind, not the first', async () => {
    const f = write('renamed.jsonl', [
      { type: 'custom-title', customTitle: 'First name' },
      { type: 'custom-title', customTitle: 'Second name' }
    ])
    expect(await titleFromTranscript(f)).toBe('Second name')
  })

  it('falls back to the model’s name', async () => {
    const f = write('ai.jsonl', [userMsg('hello'), { type: 'ai-title', aiTitle: 'Generated name' }])
    expect(await titleFromTranscript(f)).toBe('Generated name')
  })

  // Not "the first user entry": the CLI records into the user's channel everything
  // it injects, so the first few can all be plumbing.
  it('falls back to the first message the owner actually typed', async () => {
    const f = write('opening.jsonl', [
      userMsg('<system-reminder>be careful</system-reminder>'),
      userMsg('[Image: screenshot.png]'),
      userMsg('the body of a skill', { isMeta: true }),
      userMsg('/commit'),
      userMsg('port the notification hook')
    ])
    expect(await titleFromTranscript(f)).toBe('port the notification hook')
  })

  it('is empty when the transcript cannot be read — a WSL path, on Windows', async () => {
    expect(await titleFromTranscript(path.join(dir, 'does-not-exist.jsonl'))).toBe('')
    expect(await titleFromTranscript('')).toBe('')
  })
})
