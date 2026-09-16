import { describe, it, expect } from 'vitest'
import { dropKindAt, highlightRect, dropLabel, planDrop, SESSION_DRAG_TYPE } from './pane-drop'

const rect = { left: 100, width: 300 } // thirds: 100..200 | 200..300 | 300..400

describe('SESSION_DRAG_TYPE', () => {
  it('is not a type the file drop path would ever see', () => {
    // Chat recognizes files by 'Files'; a custom type guarantees the two
    // drags never get confused.
    expect(SESSION_DRAG_TYPE).not.toBe('Files')
    expect(SESSION_DRAG_TYPE).not.toBe('text/plain')
  })
})

describe('dropKindAt', () => {
  it('splits the pane into thirds', () => {
    expect(dropKindAt(110, rect, true)).toBe('left')
    expect(dropKindAt(250, rect, true)).toBe('center')
    expect(dropKindAt(390, rect, true)).toBe('right')
  })

  it('puts the boundaries on the outer side of the centre', () => {
    expect(dropKindAt(199.9, rect, true)).toBe('left')
    expect(dropKindAt(200, rect, true)).toBe('center')
    expect(dropKindAt(299.9, rect, true)).toBe('center')
    expect(dropKindAt(300, rect, true)).toBe('right')
  })

  it('clamps a cursor outside the pane to the nearest edge zone', () => {
    expect(dropKindAt(0, rect, true)).toBe('left')
    expect(dropKindAt(9999, rect, true)).toBe('right')
  })

  it('offers only the centre when there is no room for another pane', () => {
    expect(dropKindAt(110, rect, false)).toBe('center')
    expect(dropKindAt(390, rect, false)).toBe('center')
  })

  it('never divides by a zero width', () => {
    expect(dropKindAt(100, { left: 100, width: 0 }, true)).toBe('center')
  })
})

describe('highlightRect', () => {
  it('covers the half the new pane will take, not the third that was hit', () => {
    expect(highlightRect('left')).toEqual({ left: 0, width: 0.5 })
    expect(highlightRect('right')).toEqual({ left: 0.5, width: 0.5 })
  })

  it('covers the whole pane for a replacement', () => {
    expect(highlightRect('center')).toEqual({ left: 0, width: 1 })
  })
})

describe('dropLabel', () => {
  it('says what will happen before the drop', () => {
    expect(dropLabel('left')).toBe('Open in split view')
    expect(dropLabel('right')).toBe('Open in split view')
    expect(dropLabel('center')).toBe('Open here')
  })
})

describe('planDrop', () => {
  const base = { sessionId: 'x', maxPanes: 3 }

  it('opens the first pane when nothing is open', () => {
    expect(planDrop({ ...base, paneIds: [], targetIndex: 0, kind: 'center' })).toEqual({
      type: 'insert',
      index: 0
    })
  })

  it('replaces the pane it was dropped on for a centre drop', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 1, kind: 'center' })).toEqual({
      type: 'replace',
      index: 1
    })
  })

  it('inserts before the pane for a left drop', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 1, kind: 'left' })).toEqual({
      type: 'insert',
      index: 1
    })
  })

  it('inserts after the pane for a right drop', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 1, kind: 'right' })).toEqual({
      type: 'insert',
      index: 2
    })
  })

  it('inserts at the very start and at the very end', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 0, kind: 'left' })).toEqual({
      type: 'insert',
      index: 0
    })
    expect(planDrop({ ...base, paneIds: ['a'], targetIndex: 0, kind: 'right' })).toEqual({
      type: 'insert',
      index: 1
    })
  })

  it('never duplicates a session already open elsewhere — it only moves focus', () => {
    expect(planDrop({ ...base, sessionId: 'b', paneIds: ['a', 'b'], targetIndex: 0, kind: 'left' })).toEqual({
      type: 'focus',
      sessionId: 'b'
    })
    expect(planDrop({ ...base, sessionId: 'b', paneIds: ['a', 'b'], targetIndex: 0, kind: 'center' })).toEqual({
      type: 'focus',
      sessionId: 'b'
    })
  })

  it('does nothing when dropped on the pane it already lives in', () => {
    expect(planDrop({ ...base, sessionId: 'a', paneIds: ['a', 'b'], targetIndex: 0, kind: 'right' })).toEqual({
      type: 'none'
    })
  })

  it('falls back to replacing when the layout is already full', () => {
    expect(
      planDrop({ ...base, paneIds: ['a', 'b', 'c'], targetIndex: 2, kind: 'right' })
    ).toEqual({ type: 'replace', index: 2 })
  })

  it('still splits at the last free slot', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 0, kind: 'right' })).toEqual({
      type: 'insert',
      index: 1
    })
  })
})
