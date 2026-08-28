import { describe, it, expect } from 'vitest'
import { ASK_RESULT_PREFIX } from './ask-answers-pure'
import {
  collectMatches,
  proseSegments,
  rawPrefilterable,
  searchableSegments,
  snippetText
} from './search-pure'

const userEntry = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'text', text }] },
  ...extra
})

const assistantEntry = (blocks: unknown[]) => ({
  type: 'assistant',
  message: { role: 'assistant', content: blocks }
})

const toolResultEntry = (content: unknown, isError = false) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content, is_error: isError }] }
})

describe('collectMatches', () => {
  it('counts every occurrence and caps the snippets', () => {
    const segments = [{ kind: 'user' as const, text: 'ping ping ping ping' }]
    const r = collectMatches(segments, 'ping', { snippetCap: 2 })
    expect(r.matchCount).toBe(4)
    expect(r.snippets).toHaveLength(2)
  })

  it('is case-insensitive and keeps the text as written', () => {
    const r = collectMatches([{ kind: 'user', text: 'Collapse only the long ones' }], 'collapse')
    expect(r.snippets[0].match).toBe('Collapse')
  })

  // indexOf('', from) returns `from` for ever when the needle is empty, and `from`
  // advances by its length — zero. The guard is here because this is the shared helper.
  it('does not spin on an empty query', () => {
    expect(collectMatches([{ kind: 'user', text: 'anything' }], '')).toEqual({
      matchCount: 0,
      snippets: []
    })
  })

  it('marks where it cut the text', () => {
    const text = `${'a'.repeat(200)}needle${'b'.repeat(200)}`
    const s = collectMatches([{ kind: 'assistant', text }], 'needle').snippets[0]
    expect(s.before.startsWith('…')).toBe(true)
    expect(s.after.endsWith('…')).toBe(true)
    expect(snippetText(s)).toContain('needle')
  })

  // Half a surrogate pair renders as a replacement character.
  it('does not cut an emoji in half', () => {
    const text = `${'🙂'.repeat(40)}needle`
    const s = collectMatches([{ kind: 'user', text }], 'needle').snippets[0]
    expect(s.before).not.toMatch(/[\uD800-\uDBFF]$/)
    expect(s.before.replace(/^…/, '')).not.toMatch(/^[\uDC00-\uDFFF]/)
  })

  it('carries the kind of the segment the hit came from', () => {
    const r = collectMatches(
      [
        { kind: 'assistant', text: 'no hit' },
        { kind: 'tool_result', text: 'hit here' }
      ],
      'hit here'
    )
    expect(r.snippets[0].kind).toBe('tool_result')
  })
})

describe('the two depths', () => {
  const bashCall = assistantEntry([
    { type: 'text', text: 'Running it now' },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }
  ])
  const bashResult = toolResultEntry('npm test passed')

  it('per-project sees prose; global sees the tool input too', () => {
    expect(proseSegments(bashCall)).toEqual([{ kind: 'assistant', text: 'Running it now' }])
    expect(searchableSegments(bashCall).map((s) => s.kind)).toEqual(['assistant', 'tool_use'])
    expect(searchableSegments(bashCall)[1].text).toContain('npm test')
  })

  it('a plain tool result is out of the narrow depth and in the wide one', () => {
    expect(proseSegments(bashResult)).toEqual([])
    expect(searchableSegments(bashResult)).toEqual([{ kind: 'tool_result', text: 'npm test passed' }])
  })

  // Without this, searching for a decision the owner made did not return the
  // conversation he made it in — the per-project search excludes tool output by
  // design, and his choice was recorded as tool output.
  it('both depths call an AskUserQuestion answer the owner’s', () => {
    const decision = toolResultEntry(
      `${ASK_RESULT_PREFIX} "How do I draw it?"="Collapse only the long ones" selected preview:\n┌──┐. You can now continue.`
    )
    const expected = { kind: 'user', text: `${ASK_RESULT_PREFIX} "How do I draw it?"="Collapse only the long ones"` }
    expect(proseSegments(decision)).toEqual([expected])
    expect(searchableSegments(decision)).toEqual([expected])
  })

  it('a failed AskUserQuestion result stays tool output', () => {
    const failed = toolResultEntry(`${ASK_RESULT_PREFIX} "a"="b"`, true)
    expect(proseSegments(failed)).toEqual([])
    expect(searchableSegments(failed)[0].kind).toBe('tool_result')
  })

  // Indexing the raw input gives snippets of `"questions":` instead of the
  // statement the owner read and answered.
  it('indexes a question as the prose it was', () => {
    const asked = assistantEntry([
      {
        type: 'tool_use',
        id: 't1',
        name: 'AskUserQuestion',
        input: {
          questions: [
            { question: 'How do I draw it?', header: 'Form', options: [{ label: 'One block', description: 'all in one' }] }
          ]
        }
      }
    ])
    const seg = searchableSegments(asked)[0]
    expect(seg.kind).toBe('assistant')
    expect(seg.text).toBe('How do I draw it?\nOne block — all in one')
  })

  it('strips reminders, and does not credit an injection to the owner', () => {
    const withReminder = userEntry('<system-reminder>be careful</system-reminder>real text')
    expect(proseSegments(withReminder)).toEqual([{ kind: 'user', text: 'real text' }])
    const injected = userEntry('the whole body of a skill', { isMeta: true })
    expect(proseSegments(injected)[0].kind).toBe('system')
    expect(searchableSegments(injected)[0].kind).toBe('system')
  })

  it('ignores entries that are neither', () => {
    expect(proseSegments({ type: 'custom-title', customTitle: 'x' })).toEqual([])
    expect(searchableSegments({ type: 'summary' })).toEqual([])
    expect(searchableSegments(null)).toEqual([])
  })
})

describe('rawPrefilterable', () => {
  // The prefilter may let extra lines through; it may never drop one that matches.
  // In the raw JSON a quote is \" and a newline is \n, so those queries do without it.
  it('is false for anything JSON escapes on the way to the line', () => {
    expect(rawPrefilterable('the "system" bubble')).toBe(false)
    expect(rawPrefilterable('one\ntwo')).toBe(false)
    expect(rawPrefilterable('C:\\Users')).toBe(false)
  })

  it('is true for an ordinary query', () => {
    expect(rawPrefilterable('collapse only the long ones')).toBe(true)
    expect(rawPrefilterable("don't")).toBe(true)
  })
})
