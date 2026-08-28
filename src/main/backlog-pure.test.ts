import { describe, it, expect } from 'vitest'
import {
  appendTopic,
  countDone,
  countPending,
  deleteAt,
  duplicateAt,
  editAt,
  locateTopic,
  parseTopics,
  pickPrimary,
  setDoneAt
} from './backlog-pure'

describe('pickPrimary', () => {
  it('prefers BACKLOG over TODO over TASKS over ROADMAP', () => {
    expect(pickPrimary(['ROADMAP.md', 'TASKS.md', 'TODO.md', 'BACKLOG.md'])).toBe('BACKLOG.md')
    expect(pickPrimary(['ROADMAP.md', 'TASKS.md', 'TODO.md'])).toBe('TODO.md')
    expect(pickPrimary(['ROADMAP.md', 'TASKS.md'])).toBe('TASKS.md')
    expect(pickPrimary(['ROADMAP.md'])).toBe('ROADMAP.md')
  })

  it('prefers the root copy over the one in docs/', () => {
    expect(pickPrimary(['docs/BACKLOG.md', 'BACKLOG.md'])).toBe('BACKLOG.md')
  })

  it('still finds the record when it only lives in docs/', () => {
    expect(pickPrimary(['README.md', 'docs/TODO.md'])).toBe('docs/TODO.md')
  })

  it('ranks by name before location — a root ROADMAP loses to docs/BACKLOG', () => {
    expect(pickPrimary(['ROADMAP.md', 'docs/BACKLOG.md'])).toBe('docs/BACKLOG.md')
  })

  it('matches the name case-insensitively', () => {
    expect(pickPrimary(['backlog.md'])).toBe('backlog.md')
    expect(pickPrimary(['Todo.MD'])).toBe('Todo.MD')
  })

  it('refuses a file that merely contains the word', () => {
    // An archived OLD-BACKLOG.md must not become the file every tick writes into.
    expect(pickPrimary(['OLD-BACKLOG.md', 'TODO.md'])).toBe('TODO.md')
    expect(pickPrimary(['OLD-BACKLOG.md', 'BACKLOG-2023.md'])).toBeNull()
  })

  it('returns null when nothing qualifies', () => {
    expect(pickPrimary([])).toBeNull()
    expect(pickPrimary(['README.md', 'src/TODO.md', 'BACKLOG.txt'])).toBeNull()
  })

  it('normalises the winner to forward slashes', () => {
    expect(pickPrimary(['docs\\BACKLOG.md'])).toBe('docs/BACKLOG.md')
  })
})

describe('parseTopics', () => {
  it('captures line, title, done, indent and section', () => {
    const text = ['# Now', '', '- [ ] ship it', '  - [x] wrote the test', '', '## Later', '- [ ] rest'].join('\n')
    const topics = parseTopics(text)
    expect(topics).toEqual([
      { line: 2, title: 'ship it', done: false, section: 'Now', indent: '' },
      { line: 3, title: 'wrote the test', done: true, section: 'Now', indent: '  ' },
      { line: 6, title: 'rest', done: false, section: 'Later', indent: '' }
    ])
  })

  it('reads both [x] and [X] as done', () => {
    const topics = parseTopics('- [x] a\n- [X] b')
    expect(topics.map((t) => t.done)).toEqual([true, true])
  })

  it('accepts -, * and + bullets', () => {
    const topics = parseTopics('- [ ] a\n* [ ] b\n+ [ ] c')
    expect(topics.map((t) => t.title)).toEqual(['a', 'b', 'c'])
  })

  it('does NOT treat a checkbox inside a fenced block as a topic', () => {
    // A backlog documenting its own format has an example in a fence; ticking that
    // would rewrite a sample, not a topic.
    const text = ['- [ ] real', '```', '- [ ] example', '```', '~~~md', '- [x] example', '~~~', '- [ ] also real'].join('\n')
    expect(parseTopics(text).map((t) => t.title)).toEqual(['real', 'also real'])
  })

  it('does not let a ``` fence close on a ~~~ line', () => {
    const text = ['```', '~~~', '- [ ] still inside', '```', '- [ ] out'].join('\n')
    expect(parseTopics(text).map((t) => t.title)).toEqual(['out'])
  })

  it('gives a topic before any heading section: null', () => {
    const topics = parseTopics('- [ ] loose\n# Now\n- [ ] filed')
    expect(topics[0].section).toBeNull()
    expect(topics[1].section).toBe('Now')
  })

  it('tolerates CRLF line endings', () => {
    const topics = parseTopics('# Now\r\n- [ ] a\r\n')
    expect(topics).toEqual([{ line: 1, title: 'a', done: false, section: 'Now', indent: '' }])
  })
})

describe('countPending / countDone', () => {
  it('counts every topic in the file, not a capped view', () => {
    const topics = parseTopics(['- [ ] a', '- [x] b', '- [ ] c', '- [ ] d'].join('\n'))
    expect(countPending(topics)).toBe(3)
    expect(countDone(topics)).toBe(1)
  })
})

describe('locateTopic', () => {
  const topics = parseTopics(['- [ ] alpha', '- [ ] beta', '- [ ] gamma'].join('\n'))

  it('answers from the index without falling back to text', () => {
    expect(locateTopic(topics, { line: 1, title: 'beta' })).toEqual({ ok: true, line: 1 })
  })

  it('prefers the index even when another line shares the title', () => {
    const dupes = parseTopics(['- [ ] same', '- [ ] other', '- [ ] same'].join('\n'))
    expect(locateTopic(dupes, { line: 2, title: 'same' })).toEqual({ ok: true, line: 2 })
  })

  it('finds a topic by title when the line moved under it', () => {
    expect(locateTopic(topics, { line: 99, title: 'gamma' })).toEqual({ ok: true, line: 2 })
  })

  it('reports stale when nothing matches any more', () => {
    expect(locateTopic(topics, { line: 4, title: 'deleted' })).toEqual({ ok: false, error: 'stale' })
  })

  it('reports ambiguous rather than writing to the first of two identical titles', () => {
    // The regression this whole module exists for: a bare text findIndex ticked the
    // first "same" whenever the user meant the second.
    const dupes = parseTopics(['- [ ] same', '- [ ] same'].join('\n'))
    expect(locateTopic(dupes, { line: 7, title: 'same' })).toEqual({
      ok: false,
      error: 'ambiguous',
      matches: 2
    })
  })

  it('treats two titles differing only in case as two topics', () => {
    const cased = parseTopics(['- [ ] Ship', '- [ ] ship'].join('\n'))
    expect(locateTopic(cased, { line: 99, title: 'ship' })).toEqual({ ok: true, line: 1 })
  })

  it('compares titles trimmed', () => {
    expect(locateTopic(topics, { line: 99, title: '  gamma  ' })).toEqual({ ok: true, line: 2 })
  })
})

describe('setDoneAt', () => {
  it('flips only the marker, keeping indent, bullet and the rest of the line', () => {
    const lines = ['  * [ ] ship it  <!-- note -->']
    expect(setDoneAt(lines, 0, true)).toEqual(['  * [x] ship it  <!-- note -->'])
    expect(setDoneAt(setDoneAt(lines, 0, true), 0, false)).toEqual(['  * [ ] ship it  <!-- note -->'])
  })

  it('leaves every other line untouched', () => {
    const lines = ['# Now', '- [ ] a', '- [ ] b']
    expect(setDoneAt(lines, 2, true)).toEqual(['# Now', '- [ ] a', '- [x] b'])
  })
})

describe('editAt', () => {
  it('replaces the title, preserving indent, bullet and marker', () => {
    expect(editAt(['    + [x] old title'], 0, 'new title')).toEqual(['    + [x] new title'])
  })

  it('trims the incoming title rather than writing its whitespace into the file', () => {
    expect(editAt(['- [ ] a'], 0, '  b  ')).toEqual(['- [ ] b'])
  })
})

describe('duplicateAt', () => {
  it('lands the copy immediately after the original, in the same section', () => {
    const lines = ['# Now', '- [ ] a', '', '## Later', '- [ ] b']
    const out = duplicateAt(lines, 1)
    expect(out).toEqual(['# Now', '- [ ] a', '- [ ] a', '', '## Later', '- [ ] b'])
    // Appending it instead would have filed the copy under "Later".
    const topics = parseTopics(out.join('\n'))
    expect(topics[1]).toMatchObject({ title: 'a', section: 'Now' })
  })
})

describe('deleteAt', () => {
  it('removes that one line and nothing else', () => {
    expect(deleteAt(['# Now', '- [ ] a', '- [ ] b'], 1)).toEqual(['# Now', '- [ ] b'])
  })

  it('returns the lines unchanged for a line that is not there', () => {
    expect(deleteAt(['- [ ] a'], 5)).toEqual(['- [ ] a'])
  })
})

describe('appendTopic', () => {
  it('inserts into a named section before the next heading', () => {
    const lines = ['# Now', '- [ ] a', '', '## Later', '- [ ] b']
    expect(appendTopic(lines, 'c', 'Now')).toEqual([
      '# Now',
      '- [ ] a',
      '- [ ] c',
      '',
      '## Later',
      '- [ ] b'
    ])
  })

  it('appends at the end for a null section', () => {
    const lines = ['# Now', '- [ ] a']
    expect(appendTopic(lines, 'b', null)).toEqual(['# Now', '- [ ] a', '- [ ] b'])
  })

  it('appends at the end for a section the file does not have', () => {
    const lines = ['# Now', '- [ ] a']
    expect(appendTopic(lines, 'b', 'Someday')).toEqual(['# Now', '- [ ] a', '- [ ] b'])
  })

  it('keeps a file that ended in a newline ending in exactly one', () => {
    const lines = '# Now\n- [ ] a\n'.split('\n')
    expect(appendTopic(lines, 'b', null).join('\n')).toBe('# Now\n- [ ] a\n- [ ] b\n')
  })

  it('does not add a trailing newline to a file that had none', () => {
    const lines = '# Now\n- [ ] a'.split('\n')
    expect(appendTopic(lines, 'b', null).join('\n')).toBe('# Now\n- [ ] a\n- [ ] b')
  })

  it('honours an indent so a nested topic stays nested', () => {
    expect(appendTopic(['- [ ] parent'], 'child', null, '  ')).toEqual([
      '- [ ] parent',
      '  - [ ] child'
    ])
  })

  it('lands after the section run rather than after the blank line under it', () => {
    const lines = ['# Now', '- [ ] a', '', '', '# Later', '- [ ] b']
    expect(appendTopic(lines, 'c', 'Now')).toEqual([
      '# Now',
      '- [ ] a',
      '- [ ] c',
      '',
      '',
      '# Later',
      '- [ ] b'
    ])
  })
})
