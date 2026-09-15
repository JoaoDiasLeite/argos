import { describe, it, expect } from 'vitest'
import { buildBacklogBackfillPrompt, filterBackfillRows, rowKind } from './sprint-backfill-pure'

describe('the backfill prompt', () => {
  it('asks for issues by default', () => {
    const p = buildBacklogBackfillPrompt()
    expect(p).toContain('the currently OPEN issues')
    expect(p).not.toContain('merge request')
  })

  it('asks for the reference and the web URL as fields of their own', () => {
    // They used to live inside the notes prose, where no card could show them.
    for (const kind of ['issues', 'merge-requests', 'both'] as const) {
      const p = buildBacklogBackfillPrompt(undefined, kind)
      expect(p).toContain('"ref"')
      expect(p).toContain('"url"')
    }
  })

  it('asks for pending merge requests, and forbids issues as a substitute', () => {
    const p = buildBacklogBackfillPrompt(undefined, 'merge-requests')
    expect(p).toContain('OPEN (pending) merge requests')
    expect(p).toContain('drafts/WIP included')
    // The failure this guards against: the MR tool 500s and the run returns issues.
    expect(p).toContain('Do NOT return issues')
    expect(p).toContain('merge request tools')
  })

  it('asks for both, and says to call both sets of tools', () => {
    const p = buildBacklogBackfillPrompt(undefined, 'both')
    expect(p).toContain('OPEN issues AND the currently OPEN (pending) merge requests')
    expect(p).toContain('call both')
  })

  it('carries the user filter and stays read-only in every mode', () => {
    for (const kind of ['issues', 'merge-requests', 'both'] as const) {
      const p = buildBacklogBackfillPrompt('adm/wm-project', kind)
      expect(p).toContain('adm/wm-project')
      expect(p).toContain('READ-ONLY')
    }
  })
})

describe('rowKind', () => {
  it('believes an explicit kind', () => {
    expect(rowKind({ kind: 'merge-request', notes: '#12 looks like an issue' })).toBe('merge-request')
    expect(rowKind({ kind: 'issue' })).toBe('issue')
  })

  it('falls back to the sigil on the ref field', () => {
    expect(rowKind({ ref: '!49', notes: 'feature/x -> dev, ready' })).toBe('merge-request')
    expect(rowKind({ ref: '#481', notes: 'Port the listing' })).toBe('issue')
  })

  it('falls back to the reference in the notes', () => {
    expect(rowKind({ notes: '!142 — feat/x → main, ready' })).toBe('merge-request')
    expect(rowKind({ notes: '#481 — port the listing' })).toBe('issue')
  })

  it('is unknown when nothing says either way', () => {
    expect(rowKind({ title: 'Something', notes: '' })).toBe('unknown')
    expect(rowKind({})).toBe('unknown')
  })
})

describe('the prompt on GitHub', () => {
  it('says pull request, never merge request', () => {
    const p = buildBacklogBackfillPrompt(undefined, 'merge-requests', 'github')
    expect(p).toContain('pull requests')
    expect(p).toContain('GitHub')
    expect(p).not.toContain('merge request')
    expect(p).not.toContain('GitLab')
  })

  it('writes GitHub references with # and warns that kind is the only discriminator', () => {
    const p = buildBacklogBackfillPrompt(undefined, 'both', 'github')
    // A "!42" would be meaningless on GitHub.
    expect(p).not.toContain('"!<number>"')
    expect(p).toContain('share one numbering sequence')
  })
})

describe('rowKind on GitHub', () => {
  it('will not read a kind out of a # that could be either', () => {
    expect(rowKind({ ref: '#49' }, 'github')).toBe('unknown')
    expect(rowKind({ notes: '#49 — some change' }, 'github')).toBe('unknown')
    // The same row on GitLab is unambiguous.
    expect(rowKind({ ref: '#49' }, 'gitlab')).toBe('issue')
  })

  it('still believes an explicit kind', () => {
    expect(rowKind({ ref: '#49', kind: 'merge-request' }, 'github')).toBe('merge-request')
  })
})

describe('filterBackfillRows on GitHub', () => {
  it('keeps unlabelled rows instead of filtering on an unusable reference', () => {
    const bare = { title: 'Something', ref: '#49' }
    expect(filterBackfillRows({ items: [bare] }, 'merge-requests', 'github').items).toEqual([bare])
  })

  it('reports wrong-kind rows in the words GitHub uses', () => {
    const issue = { kind: 'issue', title: 'A bug', ref: '#12' }
    const res = filterBackfillRows({ items: [issue] }, 'merge-requests', 'github')
    expect(res.warning).toContain('GitHub returned 1 issue instead of pull requests')
  })
})

describe('filterBackfillRows', () => {
  const mr = { kind: 'merge-request', title: 'Cache the burndown', notes: '!142 — ready' }
  const issue = { kind: 'issue', title: 'Port the listing', notes: '#481 — dev' }

  it('drops issues from a merge-request fetch and says what happened', () => {
    const res = filterBackfillRows({ items: [mr, issue] }, 'merge-requests')
    expect(res.items).toEqual([mr])
    expect(res.warning).toContain('1 issue')
  })

  it('names the likely cause when nothing of the right kind came back', () => {
    // The reported bug: every row was an issue, so the picker looked ignored.
    const res = filterBackfillRows({ items: [issue, issue] }, 'merge-requests')
    expect(res.items).toEqual([])
    expect(res.warning).toContain('merge request tools may be failing')
  })

  it('drops merge requests from an issues fetch', () => {
    const res = filterBackfillRows({ items: [mr, issue] }, 'issues')
    expect(res.items).toEqual([issue])
    expect(res.warning).toContain('1 merge request')
  })

  it('keeps everything for both, and passes the model’s own error through', () => {
    const res = filterBackfillRows({ items: [mr, issue], error: 'The issue tool timed out.' }, 'both')
    expect(res.items).toHaveLength(2)
    expect(res.warning).toBe('The issue tool timed out.')
  })

  it('keeps unlabelled rows rather than guessing them away', () => {
    const bare = { title: 'No reference anywhere' }
    expect(filterBackfillRows({ items: [bare] }, 'merge-requests').items).toEqual([bare])
    expect(filterBackfillRows({ items: [bare] }, 'issues').items).toEqual([bare])
  })

  it('reports nothing when the fetch was clean', () => {
    expect(filterBackfillRows({ items: [mr] }, 'merge-requests').warning).toBeUndefined()
  })

  it('survives junk in place of a response', () => {
    expect(filterBackfillRows(null, 'issues')).toEqual({ items: [], warning: undefined })
    expect(filterBackfillRows({ items: 'nope' }, 'issues').items).toEqual([])
    expect(filterBackfillRows({ items: [null, mr] }, 'merge-requests').items).toEqual([mr])
  })
})
