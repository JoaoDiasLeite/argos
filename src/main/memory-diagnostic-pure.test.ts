import { describe, it, expect } from 'vitest'
import {
  findGaps,
  layersOf,
  parseFrontmatter,
  parseIndexPointers,
  parseWikiLinks,
  scoreOf
} from './memory-diagnostic-pure'
import type { DiagnosisInput, LayerInput, MemoriesInput, MemoryFileInput } from './memory-diagnostic-pure'
import type { MemoryGap, MemoryLayer } from './memory-diagnostic'

// ─── Builders ─────────────────────────────────────────────────────────────────

function layer(p: string, text: string): LayerInput {
  return { path: p, exists: true, text, bytes: text.length }
}

function absent(p: string): LayerInput {
  return { path: p, exists: false, text: '', bytes: 0 }
}

function memoryFile(file: string, text: string): MemoryFileInput {
  return { file, text, bytes: text.length }
}

/** A memory file the way Claude Code writes one. */
function memory(name: string, body = 'A fact worth keeping.'): MemoryFileInput {
  return memoryFile(
    `${name}.md`,
    `---\nname: ${name}\ndescription: "what ${name} is about"\nmetadata:\n  node_type: memory\n  type: project\n---\n\n${body}\n`
  )
}

function index(...targets: string[]): MemoryFileInput {
  return memoryFile('MEMORY.md', `# Memory index\n\n${targets.map((t) => `- [${t}](${t})`).join('\n')}\n`)
}

function memories(over: Partial<MemoriesInput> = {}): MemoriesInput {
  return { path: 'C:\\home\\.claude\\projects\\enc\\memory', exists: true, files: [], ...over }
}

/** A project whose three layers are all present and all consistent. */
function healthy(over: Partial<DiagnosisInput> = {}): DiagnosisInput {
  return {
    global: layer('C:\\home\\.claude\\CLAUDE.md', '# Always'),
    project: layer('C:\\dev\\foo\\CLAUDE.md', '# This repo'),
    memories: memories({ index: index('a.md'), files: [memory('a')] }),
    ...over
  }
}

const messages = (gaps: MemoryGap[]): string[] => gaps.map((g) => g.message)

// ─── parseFrontmatter ─────────────────────────────────────────────────────────

describe('parseFrontmatter', () => {
  it('reads the name, description and nested metadata.type of a well-formed header', () => {
    const fm = parseFrontmatter(
      '---\nname: codex-usage\ndescription: how usage is read\nmetadata:\n  node_type: memory\n  type: reference\n---\n\nBody.\n'
    )
    expect(fm).toEqual({
      present: true,
      name: 'codex-usage',
      description: 'how usage is read',
      type: 'reference',
      body: '\nBody.\n'
    })
  })

  it('reports no block at all and hands back the whole text as the body', () => {
    const fm = parseFrontmatter('Just a note someone dropped in the folder.\n')
    expect(fm.present).toBe(false)
    expect(fm.name).toBeUndefined()
    expect(fm.type).toBeUndefined()
    expect(fm.body).toBe('Just a note someone dropped in the folder.\n')
  })

  it('hands back a type outside the four rather than rejecting it', () => {
    // Deciding it is wrong is findGaps' job — the parser only reports what is written.
    expect(parseFrontmatter('---\nname: n\nmetadata:\n  type: nonsense\n---\n').type).toBe('nonsense')
  })

  it('strips the quotes off a quoted value', () => {
    const fm = parseFrontmatter('---\nname: "quoted-name"\ndescription: \'single\'\nmetadata:\n  type: user\n---\n')
    expect(fm.name).toBe('quoted-name')
    expect(fm.description).toBe('single')
  })

  it('does not mistake a top-level type for the one inside metadata', () => {
    // `type` at the root is not `metadata.type`, and reading it as one would pass a
    // file that Claude Code itself cannot classify.
    expect(parseFrontmatter('---\nname: n\ntype: project\n---\n').type).toBeUndefined()
  })

  it('stops the metadata block at the next unindented key', () => {
    const fm = parseFrontmatter('---\nmetadata:\n  type: feedback\nname: after\n---\n')
    expect(fm.type).toBe('feedback')
    expect(fm.name).toBe('after')
  })

  it('starts the body after the closing delimiter', () => {
    expect(parseFrontmatter('---\nname: n\n---\nfirst line\n').body).toBe('first line\n')
  })
})

// ─── parseIndexPointers ───────────────────────────────────────────────────────

describe('parseIndexPointers', () => {
  it('reads pointers written as bullets and as bare links alike', () => {
    const parsed = parseIndexPointers('- [One](one.md)\n[Two](two.md)\n')
    expect(parsed.pointers).toEqual(['one.md', 'two.md'])
    expect(parsed.extraLines).toEqual([])
  })

  it('names a file pointed at twice only once', () => {
    expect(parseIndexPointers('- [One](one.md)\n- [Again](one.md)\n').pointers).toEqual(['one.md'])
  })

  it('does not count the index heading as content', () => {
    const parsed = parseIndexPointers('# Memory index\n\n- [One](one.md)\n')
    expect(parsed.pointers).toEqual(['one.md'])
    expect(parsed.extraLines).toEqual([])
  })

  it('counts an external link as content rather than a pointer at a memory', () => {
    const parsed = parseIndexPointers('- [Docs](https://example.com/x)\n')
    expect(parsed.pointers).toEqual([])
    expect(parsed.extraLines).toEqual(['- [Docs](https://example.com/x)'])
  })

  it('captures a line of prose as content the index should not be holding', () => {
    const parsed = parseIndexPointers('- [One](one.md)\nRemember that the build is flaky on Fridays.\n')
    expect(parsed.pointers).toEqual(['one.md'])
    expect(parsed.extraLines).toEqual(['Remember that the build is flaky on Fridays.'])
  })

  it('keeps the trailing prose of a pointer line out of the target', () => {
    expect(parseIndexPointers('- [One](one.md) — a one-line summary\n').pointers).toEqual(['one.md'])
  })
})

// ─── parseWikiLinks ───────────────────────────────────────────────────────────

describe('parseWikiLinks', () => {
  it('reads every link once, trimmed', () => {
    expect(parseWikiLinks('see [[ alpha ]] and [[beta]], and [[alpha]] again')).toEqual(['alpha', 'beta'])
  })

  it('finds none in a body that links to nothing', () => {
    expect(parseWikiLinks('plain prose with [a link](x.md)')).toEqual([])
  })
})

// ─── layersOf ─────────────────────────────────────────────────────────────────

describe('layersOf', () => {
  it('reports all three layers when a project was named', () => {
    expect(layersOf(healthy()).map((l) => l.id)).toEqual(['global', 'project', 'memories'])
  })

  it('omits the project layer when the caller named no project', () => {
    const layers = layersOf(healthy({ project: undefined }))
    expect(layers.map((l) => l.id)).toEqual(['global', 'memories'])
  })

  it('counts the memory files without counting MEMORY.md as one of them', () => {
    // The index is what loads the memories; it is not itself a fact.
    const layers = layersOf(healthy({ memories: memories({ index: index('a.md'), files: [memory('a'), memory('b')] }) }))
    expect(layers.find((l) => l.id === 'memories')?.files).toBe(2)
  })

  it('sums the bytes of the index and the memories together', () => {
    const idx = memoryFile('MEMORY.md', '12345')
    const one = memoryFile('a.md', '1234567890')
    const layers = layersOf(healthy({ memories: memories({ index: idx, files: [one] }) }))
    expect(layers.find((l) => l.id === 'memories')?.bytes).toBe(15)
  })

  it('reports a memory directory that is not there as absent and empty', () => {
    const layers = layersOf(healthy({ memories: memories({ exists: false, index: undefined, files: [] }) }))
    const mem = layers.find((l) => l.id === 'memories')
    expect(mem?.exists).toBe(false)
    expect(mem?.bytes).toBe(0)
    expect(mem?.files).toBe(0)
  })
})

// ─── findGaps ─────────────────────────────────────────────────────────────────

describe('findGaps', () => {
  it('finds nothing to report in a project whose three layers all line up', () => {
    expect(findGaps(healthy())).toEqual([])
  })

  it('calls a CLAUDE.md that is not there an absence, not a fault', () => {
    const gaps = findGaps(healthy({ global: absent('C:\\home\\.claude\\CLAUDE.md') }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].layer).toBe('global')
    expect(gaps[0].severity).toBe('info')
    expect(gaps[0].message).toContain('C:\\home\\.claude\\CLAUDE.md')
  })

  it('calls a CLAUDE.md holding nothing but whitespace an absence too', () => {
    const gaps = findGaps(healthy({ project: layer('C:\\dev\\foo\\CLAUDE.md', '   \n\t\n') }))
    expect(gaps).toEqual([
      { layer: 'project', severity: 'info', message: 'C:\\dev\\foo\\CLAUDE.md exists but is empty.' }
    ])
  })

  it('calls a CLAUDE.md that is there but unreadable a fault', () => {
    // The file exists and something is wrong with it — that is broken, not missing.
    const gaps = findGaps(healthy({ global: { ...layer('C:\\home\\.claude\\CLAUDE.md', ''), error: 'EACCES' } }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('warn')
    expect(gaps[0].message).toContain('EACCES')
  })

  it('calls a memory directory that does not exist yet an absence, since that is where every project starts', () => {
    const gaps = findGaps(healthy({ memories: memories({ exists: false, index: undefined, files: [] }) }))
    expect(gaps).toEqual([
      {
        layer: 'memories',
        severity: 'info',
        message: expect.stringContaining('No memory directory at C:\\home\\.claude\\projects\\enc\\memory') as string
      }
    ])
  })

  it('calls an empty memory directory an absence rather than a fault', () => {
    const gaps = findGaps(healthy({ memories: memories({ index: undefined, files: [] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('info')
  })

  it('calls memory files sitting there with no MEMORY.md a fault, because nothing loads them', () => {
    const gaps = findGaps(healthy({ memories: memories({ index: undefined, files: [memory('a')] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('warn')
    expect(gaps[0].message).toContain('no MEMORY.md index')
  })

  it('calls an index pointing at a file that is not there a fault, and names the file', () => {
    const gaps = findGaps(healthy({ memories: memories({ index: index('a.md', 'gone.md'), files: [memory('a')] }) }))
    expect(gaps).toEqual([
      { layer: 'memories', severity: 'warn', message: 'MEMORY.md points at gone.md, which is not in the memory directory.' }
    ])
  })

  it('calls a memory the index does not list a fault, and names the file', () => {
    const gaps = findGaps(healthy({ memories: memories({ index: index('a.md'), files: [memory('a'), memory('orphan')] }) }))
    expect(gaps).toEqual([
      {
        layer: 'memories',
        severity: 'warn',
        message: 'orphan.md is not listed in MEMORY.md, so nothing loads it into context.'
      }
    ])
  })

  it('calls a memory file with no frontmatter at all a fault, and names the file', () => {
    const loose = memoryFile('loose.md', 'Just prose, no header.\n')
    const gaps = findGaps(healthy({ memories: memories({ index: index('loose.md'), files: [loose] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('warn')
    expect(gaps[0].message).toContain('loose.md')
    expect(gaps[0].message).toContain('no frontmatter block')
  })

  it('calls a memory file missing required frontmatter fields a fault, and names them', () => {
    const partial = memoryFile('partial.md', '---\nname: partial\n---\n\nBody.\n')
    const gaps = findGaps(healthy({ memories: memories({ index: index('partial.md'), files: [partial] }) }))
    expect(gaps).toEqual([
      {
        layer: 'memories',
        severity: 'warn',
        message: 'partial.md is missing required frontmatter: description, metadata.type.'
      }
    ])
  })

  it('calls a metadata.type outside the four kinds a fault, and names the file', () => {
    const odd = memoryFile('odd.md', '---\nname: odd\ndescription: d\nmetadata:\n  type: musings\n---\n\nBody.\n')
    const gaps = findGaps(healthy({ memories: memories({ index: index('odd.md'), files: [odd] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('warn')
    expect(gaps[0].message).toContain('odd.md')
    expect(gaps[0].message).toContain('musings')
  })

  it('accepts each of the four kinds without complaint', () => {
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      const f = memoryFile('k.md', `---\nname: k\ndescription: d\nmetadata:\n  type: ${type}\n---\n\nBody.\n`)
      expect(findGaps(healthy({ memories: memories({ index: index('k.md'), files: [f] }) }))).toEqual([])
    }
  })

  it('calls content in MEMORY.md beyond its pointers an absence of tidiness, not a fault', () => {
    const idx = memoryFile('MEMORY.md', '# Memory index\n\n- [a.md](a.md)\nThe deploy key rotates every March.\n')
    const gaps = findGaps(healthy({ memories: memories({ index: idx, files: [memory('a')] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('info')
    expect(gaps[0].message).toContain('not pointers')
  })

  it('calls a dangling wiki-link a note rather than a defect, because that is how work worth doing gets marked', () => {
    const a = memory('a', 'This relates to [[something nobody wrote yet]].')
    const gaps = findGaps(healthy({ memories: memories({ index: index('a.md'), files: [a] }) }))
    expect(gaps).toHaveLength(1)
    expect(gaps[0].severity).toBe('info')
    expect(gaps[0].message).toContain('a.md')
    expect(gaps[0].message).toContain('[[something nobody wrote yet]]')
  })

  it('says nothing about a wiki-link to a memory that does exist', () => {
    const a = memory('a', 'See [[b]] for the rest.')
    const gaps = findGaps(healthy({ memories: memories({ index: index('a.md', 'b.md'), files: [a, memory('b')] }) }))
    expect(gaps).toEqual([])
  })

  it('resolves a wiki-link by the file name when the header carries no name of its own', () => {
    const unnamed = memoryFile('unnamed.md', '---\nname: n\ndescription: d\nmetadata:\n  type: project\n---\n\nBody.\n')
    // `unnamed.md` answers to `n` by its header and to `unnamed` by its file name.
    const a = memory('a', 'See [[unnamed]].')
    const gaps = findGaps(
      healthy({ memories: memories({ index: index('a.md', 'unnamed.md'), files: [a, unnamed] }) })
    )
    expect(messages(gaps).filter((m) => m.includes('[['))).toEqual([])
  })

  it('reports every layer it was given, not just the first one that was wrong', () => {
    const gaps = findGaps({
      global: absent('C:\\home\\.claude\\CLAUDE.md'),
      project: absent('C:\\dev\\foo\\CLAUDE.md'),
      memories: memories({ exists: false, files: [] })
    })
    expect(gaps.map((g) => g.layer)).toEqual(['global', 'project', 'memories'])
    expect(gaps.every((g) => g.severity === 'info')).toBe(true)
  })

  it('says nothing about a project layer the caller never asked about', () => {
    const gaps = findGaps(healthy({ project: undefined }))
    expect(gaps.some((g) => g.layer === 'project')).toBe(false)
  })
})

// ─── scoreOf ──────────────────────────────────────────────────────────────────

describe('scoreOf', () => {
  const full = (id: MemoryLayer['id']): MemoryLayer => ({
    id,
    label: id,
    path: `p/${id}`,
    exists: true,
    bytes: 100
  })
  const gone = (id: MemoryLayer['id']): MemoryLayer => ({ ...full(id), exists: false, bytes: 0 })
  const warn: MemoryGap = { layer: 'memories', severity: 'warn', message: 'w' }
  const info: MemoryGap = { layer: 'memories', severity: 'info', message: 'i' }

  it('gives a report with everything present and nothing wrong the full 100', () => {
    expect(scoreOf([full('global'), full('project'), full('memories')], [])).toBe(100)
  })

  it('gives a report with nothing present and much broken 0, never less', () => {
    const gaps = Array.from({ length: 12 }, () => warn)
    expect(scoreOf([gone('global'), gone('project'), gone('memories')], gaps)).toBe(0)
  })

  it('never goes above 100 or below 0', () => {
    const layers = [full('global'), full('project'), full('memories')]
    for (const gaps of [[], [info], [warn], Array.from({ length: 50 }, () => warn)]) {
      const score = scoreOf(layers, gaps)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(100)
    }
  })

  it('charges more for something broken than for something merely absent', () => {
    const layers = [full('global'), full('project'), full('memories')]
    expect(scoreOf(layers, [warn])).toBeLessThan(scoreOf(layers, [info]))
  })

  it('never scores a layer that is present below the same layer gone', () => {
    const gaps = [warn, info]
    const withProject = scoreOf([full('global'), full('project'), full('memories')], gaps)
    const withoutProject = scoreOf([full('global'), gone('project'), full('memories')], gaps)
    expect(withProject).toBeGreaterThan(withoutProject)
  })

  it('scores a layer that is present but empty between one with content and one gone', () => {
    const empty: MemoryLayer = { ...full('project'), bytes: 0 }
    const at = (l: MemoryLayer): number => scoreOf([full('global'), l, full('memories')], [])
    expect(at(gone('project'))).toBeLessThan(at(empty))
    expect(at(empty)).toBeLessThan(at(full('project')))
  })

  it('falls as gaps accumulate and never rises', () => {
    const layers = [full('global'), full('project'), full('memories')]
    const scores = [0, 1, 2, 3, 4, 5].map((n) => scoreOf(layers, Array.from({ length: n }, () => warn)))
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1])
  })

  it('scores an empty layer list 0 rather than dividing by nothing', () => {
    expect(scoreOf([], [])).toBe(0)
  })
})
