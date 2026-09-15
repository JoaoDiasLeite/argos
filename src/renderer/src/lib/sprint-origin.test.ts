import { describe, it, expect } from 'vitest'
import { originOf, kindLabel } from './sprint-origin'

describe('kindLabel', () => {
  it('uses each forge’s own word', () => {
    expect(kindLabel('gitlab', 'merge-request')).toBe('Merge request')
    expect(kindLabel('github', 'merge-request')).toBe('Pull request')
    expect(kindLabel('github', 'issue')).toBe('Issue')
  })
})

describe('originOf', () => {
  it('uses the stored fields when the item has them', () => {
    expect(originOf({ ref: '!49', kind: 'merge-request', forge: 'gitlab', notes: '' })).toEqual({
      ref: '!49',
      kind: 'merge-request',
      forge: 'gitlab'
    })
  })

  it('reads the reference out of the notes of an older imported item', () => {
    // Exactly what the importer wrote before `ref` and `forge` existed — always GitLab.
    expect(originOf({ notes: '#481 — Port the workflow listing and "My workflows" restyle to dev.' })).toEqual({
      ref: '#481',
      kind: 'issue',
      forge: 'gitlab'
    })
    expect(
      originOf({ notes: '!49, feature/descontinuar-gestao-short-urls → dev, ready, awaiting review' })
    ).toEqual({ ref: '!49', kind: 'merge-request', forge: 'gitlab' })
  })

  it('gives a bare stored ref its sigil back from the kind', () => {
    expect(originOf({ ref: '142', kind: 'merge-request', forge: 'gitlab' })).toEqual({
      ref: '!142',
      kind: 'merge-request',
      forge: 'gitlab'
    })
    expect(originOf({ ref: '142', kind: 'issue', forge: 'gitlab' })).toEqual({
      ref: '#142',
      kind: 'issue',
      forge: 'gitlab'
    })
  })

  it('writes a GitHub pull request with #, never !', () => {
    // GitHub shares one numbering sequence between issues and PRs.
    expect(originOf({ ref: '49', kind: 'merge-request', forge: 'github' })).toEqual({
      ref: '#49',
      kind: 'merge-request',
      forge: 'github'
    })
    expect(originOf({ ref: '#49', kind: 'issue', forge: 'github' })).toEqual({
      ref: '#49',
      kind: 'issue',
      forge: 'github'
    })
  })

  it('will not place a GitHub row that never said which kind it is', () => {
    // On GitLab the sigil would settle it; on GitHub it is genuinely unknowable.
    expect(originOf({ ref: '#49', forge: 'github' })).toBeNull()
    expect(originOf({ notes: '#49 — some change', forge: 'github' })).toBeNull()
    expect(originOf({ ref: '#49', forge: 'gitlab' })).toEqual({
      ref: '#49',
      kind: 'issue',
      forge: 'gitlab'
    })
  })

  it('lets the stored kind overrule a sigil in the notes', () => {
    expect(originOf({ kind: 'merge-request', notes: 'closes #481, ready for review' })).toEqual({
      ref: '!481',
      kind: 'merge-request',
      forge: 'gitlab'
    })
  })

  it('has no origin for a hand-typed item', () => {
    expect(originOf({ notes: 'Talk to design about the empty state' })).toBeNull()
    expect(originOf({})).toBeNull()
    expect(originOf({ notes: null, ref: null, kind: null })).toBeNull()
  })

  it('does not invent an origin out of a stray hash', () => {
    expect(originOf({ notes: 'Use the C#9 syntax' })).toBeNull()
    expect(originOf({ notes: 'colour is rgb(#481)' })).toBeNull()
  })

  it('cannot place a bare ref with no kind', () => {
    expect(originOf({ ref: '481' })).toBeNull()
  })
})
