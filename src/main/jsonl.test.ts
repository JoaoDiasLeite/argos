import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { iterJsonl, iterJsonlEntries, sniffCwd } from './jsonl'

let dir: string

function write(name: string, body: string): string {
  const p = path.join(dir, name)
  fs.writeFileSync(p, body, 'utf-8')
  return p
}

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'argos-jsonl-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('iterJsonl', () => {
  it('yields every parseable entry in order', async () => {
    const f = write('ok.jsonl', '{"type":"a","n":1}\n{"type":"b","n":2}\n{"type":"c","n":3}\n')
    const out: number[] = []
    for await (const obj of iterJsonl(f)) out.push(obj.n)
    expect(out).toEqual([1, 2, 3])
  })

  it('skips blank lines and a trailing partial write', async () => {
    // A live `claude` appends to this file, so the last line can be half-written.
    // Losing the rest of the conversation over it is the failure to avoid.
    const f = write('partial.jsonl', '{"n":1}\n\n   \n{"n":2}\n{"n":3,"broken":\n')
    const out: number[] = []
    for await (const obj of iterJsonl(f)) out.push(obj.n)
    expect(out).toEqual([1, 2])
  })

  it('keeps scanning past a corrupt line in the middle', async () => {
    const f = write('corrupt.jsonl', '{"n":1}\nnot json at all\n{"n":2}\n')
    const out: number[] = []
    for await (const obj of iterJsonl(f)) out.push(obj.n)
    expect(out).toEqual([1, 2])
  })

  it('handles CRLF line endings', async () => {
    const f = write('crlf.jsonl', '{"n":1}\r\n{"n":2}\r\n')
    const out: number[] = []
    for await (const obj of iterJsonl(f)) out.push(obj.n)
    expect(out).toEqual([1, 2])
  })

  it('yields nothing for an empty file', async () => {
    const f = write('empty.jsonl', '')
    const out: unknown[] = []
    for await (const obj of iterJsonl(f)) out.push(obj)
    expect(out).toEqual([])
  })

  it('propagates a read error instead of reporting an empty transcript', async () => {
    // Swallowing this centrally would make a missing or unreadable file look like
    // a conversation with no messages. Callers that tolerate it say so themselves.
    const missing = path.join(dir, 'does-not-exist.jsonl')
    await expect(async () => {
      for await (const _ of iterJsonl(missing)) void _
    }).rejects.toThrow()
  })
})

describe('iterJsonlEntries', () => {
  it('hands back the original line alongside the parsed object', async () => {
    // Search matches against the serialized form so a hit inside a tool input
    // still counts; re-serializing the parsed object would not round-trip.
    const f = write('raw.jsonl', '{"type":"a",  "n":1}\n')
    const seen: string[] = []
    for await (const { raw, obj } of iterJsonlEntries(f)) {
      seen.push(raw)
      expect(obj.n).toBe(1)
    }
    expect(seen).toEqual(['{"type":"a",  "n":1}'])
  })
})

describe('the raw prefilter', () => {
  it('skips the parse for lines that fail the test', async () => {
    // The regression this guards: dropping the prefilter and filtering the parsed
    // object instead. Correct, and it parses every line of every transcript in every
    // project to keep the few that carry usage. A line that would throw on parse but
    // fails the filter proves the parse never happened.
    const f = write('filter.jsonl', '{"usage":{"n":1}}\n{"broken":\n{"usage":{"n":2}}\n')
    const out: number[] = []
    for await (const obj of iterJsonl(f, { match: (raw) => raw.includes('"usage"') })) {
      out.push(obj.usage.n)
    }
    expect(out).toEqual([1, 2])
  })

  it('passes every line through when no filter is given', async () => {
    const f = write('nofilter.jsonl', '{"a":1}\n{"b":2}\n')
    let n = 0
    for await (const _ of iterJsonl(f)) n++
    expect(n).toBe(2)
  })
})

describe('sniffCwd', () => {
  it('returns the first cwd it finds', async () => {
    const f = write(
      'cwd.jsonl',
      '{"type":"x"}\n{"type":"user","cwd":"/home/jdl/one"}\n{"type":"user","cwd":"/home/jdl/two"}\n'
    )
    expect(await sniffCwd(f)).toBe('/home/jdl/one')
  })

  it('stops reading at the first hit', async () => {
    // The point of the sniff: the encoded directory name is lossy, so the real path
    // comes from the transcript — but that must not cost a full read of a huge file.
    // A JSON syntax error after the hit would surface only if we kept going.
    const f = write('early.jsonl', '{"cwd":"/home/jdl/one"}\n' + '{"cwd":\n'.repeat(3))
    expect(await sniffCwd(f)).toBe('/home/jdl/one')
  })

  it('ignores a blank or non-string cwd', async () => {
    const f = write('badcwd.jsonl', '{"cwd":""}\n{"cwd":42}\n{"cwd":"/real"}\n')
    expect(await sniffCwd(f)).toBe('/real')
  })

  it('returns null when no entry carries a cwd', async () => {
    const f = write('nocwd.jsonl', '{"type":"a"}\n{"type":"b"}\n')
    expect(await sniffCwd(f)).toBeNull()
  })
})
