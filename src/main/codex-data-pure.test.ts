import { describe, it, expect } from 'vitest'
import {
  CodexRolloutFacts,
  codexContentText,
  codexUserText,
  encodeProjectPath,
  groupRolloutsByCwd,
  parseRolloutFileName,
  pathBasename,
  reduceThreadNames
} from './codex-data-pure'

describe('encodeProjectPath', () => {
  it('matches the encoding Claude Code uses for its project directories', () => {
    // The whole point of sharing it: the same folder opened in either CLI has to
    // produce the same id, or Projects shows the project twice.
    expect(encodeProjectPath('C:\\Users\\Jo\u00e3oLeite\\Desktop\\claude-gui')).toBe(
      'C--Users-Jo-oLeite-Desktop-claude-gui'
    )
    expect(encodeProjectPath('/home/jdl/dev/wm-project')).toBe('-home-jdl-dev-wm-project')
  })
})

describe('pathBasename', () => {
  it('handles both separators and a trailing one', () => {
    expect(pathBasename('C:\\a\\b\\claude-gui')).toBe('claude-gui')
    expect(pathBasename('/home/jdl/dev/')).toBe('dev')
  })
})

describe('parseRolloutFileName', () => {
  it('splits the uuid from the timestamp that is also dash-separated', () => {
    const parsed = parseRolloutFileName(
      'rollout-2026-09-09T11-20-05-01a085ae-90a3-70c2-815d-7d542e1760f3.jsonl'
    )
    expect(parsed?.sessionId).toBe('01a085ae-90a3-70c2-815d-7d542e1760f3')
    // Local time — the name is stamped locally while the header inside carries UTC.
    expect(new Date(parsed?.startedAt ?? 0).getFullYear()).toBe(2026)
    expect(new Date(parsed?.startedAt ?? 0).getHours()).toBe(11)
  })

  it('rejects anything that is not a transcript', () => {
    // The sessions tree also holds lock files and half-written temporaries; taking
    // one for a session would list a conversation that does not exist.
    expect(parseRolloutFileName('rollout-2026-09-09T11-20-05-not-a-uuid.jsonl')).toBeNull()
    expect(parseRolloutFileName('session_index.jsonl')).toBeNull()
    expect(parseRolloutFileName('rollout-2026-09-09T11-20-05-01a085ae-90a3-70c2-815d-7d542e1760f3.tmp')).toBeNull()
  })
})

describe('reduceThreadNames', () => {
  const entry = (id: string, name: string, at: string): unknown => ({ id, thread_name: name, updated_at: at })

  it('takes the last entry for an id', () => {
    // session_index.jsonl is append-only: a rename adds a line rather than editing
    // one, so reading the first would show the name the thread has already lost.
    const names = reduceThreadNames([
      entry('a', 'check this app and graphically sugse', '2026-09-09T10:20:56Z'),
      entry('a', 'Review app improvements', '2026-09-09T10:21:01Z'),
      entry('b', 'Other thread', '2026-09-09T10:22:00Z')
    ])
    expect(names.get('a')).toBe('Review app improvements')
    expect(names.get('b')).toBe('Other thread')
  })

  it('does not let a malformed record erase a name already read', () => {
    // Missing information is not an instruction to forget.
    const names = reduceThreadNames([
      entry('a', 'Real name', '2026-01-01T00:00:00Z'),
      { id: 'a', updated_at: '2026-01-02T00:00:00Z' },
      { id: 'a', thread_name: '   ', updated_at: '2026-01-03T00:00:00Z' }
    ])
    expect(names.get('a')).toBe('Real name')
  })

  it('ignores anything that is not a record with both fields', () => {
    expect(reduceThreadNames([null, undefined, 'a string', 42, { thread_name: 'no id' }]).size).toBe(0)
  })
})

describe('codexContentText', () => {
  it('joins the text parts of either direction', () => {
    expect(
      codexContentText([
        { type: 'input_text', text: 'one' },
        { type: 'output_text', text: 'two' },
        { type: 'image', url: 'x' }
      ])
    ).toBe('one two')
  })

  it('is empty for anything that is not a content array', () => {
    expect(codexContentText(undefined)).toBe('')
    expect(codexContentText({ text: 'no' })).toBe('')
  })
})

describe('codexUserText', () => {
  it('drops the context blocks Codex injects into the user channel', () => {
    // The real failure this guards: Codex opens every conversation by putting its own
    // sandbox policy and plugin list in the user's own channel, so the first user
    // entry taken at face value gives a preview made entirely of plumbing.
    const content = [
      { type: 'input_text', text: '<environment_context>\n  <cwd>C:\\x</cwd>\n</environment_context>' }
    ]
    expect(codexUserText(content)).toBe('')
  })

  it('strips several stacked blocks and keeps what follows', () => {
    const content = [
      { type: 'input_text', text: '<recommended_plugins>a</recommended_plugins>' },
      { type: 'input_text', text: '<environment_context>b</environment_context>\nreply with: hello' }
    ]
    expect(codexUserText(content)).toBe('reply with: hello')
  })

  it('leaves a real message alone', () => {
    const content = [{ type: 'input_text', text: 'do a review from commit 6b0994c' }]
    expect(codexUserText(content)).toBe('do a review from commit 6b0994c')
  })

  it('only strips a block that opens the message', () => {
    // Anchored on purpose: an unanchored strip would eat markup a person typed.
    const content = [{ type: 'input_text', text: 'why does <div>x</div> break?' }]
    expect(codexUserText(content)).toBe('why does <div>x</div> break?')
  })
})

describe('groupRolloutsByCwd', () => {
  const fact = (cwd: string, mtime: number, id = cwd + mtime): CodexRolloutFacts => ({
    sessionId: id,
    file: `/sessions/${id}.jsonl`,
    cwd,
    createdAt: mtime,
    mtime
  })

  it('makes one project per cwd, counting its sessions and taking the newest mtime', () => {
    const groups = groupRolloutsByCwd([
      fact('C:\\dev\\a', 100),
      fact('C:\\dev\\a', 300),
      fact('C:\\dev\\b', 200)
    ])
    expect(groups.map((g) => [g.name, g.sessionCount, g.lastActive])).toEqual([
      ['a', 2, 300],
      ['b', 1, 200]
    ])
  })

  it('gives the same encodedDir Claude Code would give the same folder', () => {
    const [group] = groupRolloutsByCwd([fact('C:\\dev\\claude-gui', 1)])
    expect(group.encodedDir).toBe(encodeProjectPath('C:\\dev\\claude-gui'))
    expect(group.realPath).toBe('C:\\dev\\claude-gui')
  })

  it('folds two spellings that encode alike into one row', () => {
    // The encoded path is the id the renderer sends back, so two rows sharing one id
    // would mean clicking either lists only half its sessions.
    const groups = groupRolloutsByCwd([fact('C:/dev/a', 100), fact('C:\\dev\\a', 200)])
    expect(groups).toHaveLength(1)
    expect(groups[0].sessionCount).toBe(2)
  })

  it('sorts by last active, newest first', () => {
    const groups = groupRolloutsByCwd([fact('C:\\old', 1), fact('C:\\new', 999)])
    expect(groups.map((g) => g.name)).toEqual(['new', 'old'])
  })

  it('ignores a transcript whose header carried no cwd', () => {
    // There is no project to put it in, and inventing one named '' would be worse.
    expect(groupRolloutsByCwd([fact('', 100)])).toEqual([])
  })

  it('is empty for an empty scan', () => {
    expect(groupRolloutsByCwd([])).toEqual([])
  })
})
