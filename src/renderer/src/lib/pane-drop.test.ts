import { describe, it, expect } from 'vitest'
import { dropKindAt, highlightRect, dropLabel, planDrop, SESSION_DRAG_TYPE } from './pane-drop'

// Thirds across: 100..200 | 200..300 | 300..400. Thirds down: 50..110 | 110..170 | 170..230.
const rect = { left: 100, width: 300, top: 50, height: 180 }
const MIDDLE = 250 // x inside the central band, where the vertical zones live
const MIDDLE_Y = 140 // y inside the central band, where 'center' lives

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

  it('reads the pane as a single band when no clientY is given', () => {
    // The column-only caller keeps the behaviour it always had.
    expect(dropKindAt(MIDDLE, rect, true)).toBe('center')
  })

  it('opens the vertical zones inside the central band', () => {
    expect(dropKindAt(MIDDLE, rect, true, 60)).toBe('top')
    expect(dropKindAt(MIDDLE, rect, true, MIDDLE_Y)).toBe('center')
    expect(dropKindAt(MIDDLE, rect, true, 220)).toBe('bottom')
  })

  it('never lets the vertical zones eat into the side ones', () => {
    // Same y that would be 'top'/'bottom' in the middle, but over a side third:
    // columns are the common case and keep their full-height hit area.
    expect(dropKindAt(110, rect, true, 60)).toBe('left')
    expect(dropKindAt(110, rect, true, 220)).toBe('left')
    expect(dropKindAt(390, rect, true, 60)).toBe('right')
    expect(dropKindAt(390, rect, true, 220)).toBe('right')
  })

  it('puts the vertical boundaries on the outer side of the centre', () => {
    expect(dropKindAt(MIDDLE, rect, true, 109.9)).toBe('top')
    expect(dropKindAt(MIDDLE, rect, true, 110)).toBe('center')
    expect(dropKindAt(MIDDLE, rect, true, 169.9)).toBe('center')
    expect(dropKindAt(MIDDLE, rect, true, 170)).toBe('bottom')
  })

  it('clamps a cursor above or below the pane to the nearest vertical zone', () => {
    expect(dropKindAt(MIDDLE, rect, true, -9999)).toBe('top')
    expect(dropKindAt(MIDDLE, rect, true, 9999)).toBe('bottom')
  })

  it('offers only the centre vertically too when there is no room for another pane', () => {
    expect(dropKindAt(MIDDLE, rect, false, 60)).toBe('center')
    expect(dropKindAt(MIDDLE, rect, false, 220)).toBe('center')
  })

  it('never divides by a zero height', () => {
    expect(dropKindAt(MIDDLE, { left: 100, width: 300, top: 50, height: 0 }, true, 60)).toBe(
      'center'
    )
  })
})

describe('highlightRect', () => {
  it('covers the half the new pane will take, not the third that was hit', () => {
    expect(highlightRect('left')).toEqual({ left: 0, width: 0.5, top: 0, height: 1 })
    expect(highlightRect('right')).toEqual({ left: 0.5, width: 0.5, top: 0, height: 1 })
  })

  it('covers a horizontal half for a vertical drop', () => {
    expect(highlightRect('top')).toEqual({ left: 0, width: 1, top: 0, height: 0.5 })
    expect(highlightRect('bottom')).toEqual({ left: 0, width: 1, top: 0.5, height: 0.5 })
  })

  it('covers the whole pane for a replacement', () => {
    expect(highlightRect('center')).toEqual({ left: 0, width: 1, top: 0, height: 1 })
  })
})

describe('dropLabel', () => {
  it('says what will happen before the drop', () => {
    expect(dropLabel('left')).toBe('Open in split view')
    expect(dropLabel('right')).toBe('Open in split view')
    expect(dropLabel('center')).toBe('Open here')
  })

  it('names the grid, which costs height, instead of calling it a split', () => {
    expect(dropLabel('top')).toBe('Open in grid')
    expect(dropLabel('bottom')).toBe('Open in grid')
  })
})

describe('planDrop', () => {
  const base = { sessionId: 'x', maxPanes: 3 }

  it('opens the first pane when nothing is open', () => {
    expect(planDrop({ ...base, paneIds: [], targetIndex: 0, kind: 'center' })).toEqual({
      type: 'insert',
      index: 0,
      layout: 'single'
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
      index: 1,
      layout: 'cols-3'
    })
  })

  it('inserts after the pane for a right drop', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 1, kind: 'right' })).toEqual({
      type: 'insert',
      index: 2,
      layout: 'cols-3'
    })
  })

  it('inserts at the very start and at the very end', () => {
    expect(planDrop({ ...base, paneIds: ['a', 'b'], targetIndex: 0, kind: 'left' })).toEqual({
      type: 'insert',
      index: 0,
      layout: 'cols-3'
    })
    expect(planDrop({ ...base, paneIds: ['a'], targetIndex: 0, kind: 'right' })).toEqual({
      type: 'insert',
      index: 1,
      layout: 'cols-2'
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
      index: 1,
      layout: 'cols-3'
    })
  })

  // ── The vertical zones ──────────────────────────────────────────────────────
  const grid = { sessionId: 'x', maxPanes: 4 }

  it('turns two panes into main-side, the big pane first', () => {
    // Dropped on the top of pane 1: the new pane goes before it, so 'a' keeps
    // index 0 and stays the full-height one.
    expect(planDrop({ ...grid, paneIds: ['a', 'b'], targetIndex: 1, kind: 'top' })).toEqual({
      type: 'insert',
      index: 1,
      layout: 'main-side'
    })
    expect(planDrop({ ...grid, paneIds: ['a', 'b'], targetIndex: 1, kind: 'bottom' })).toEqual({
      type: 'insert',
      index: 2,
      layout: 'main-side'
    })
  })

  it('takes the new pane to index 0 when dropped on the top of the first pane', () => {
    expect(planDrop({ ...grid, paneIds: ['a', 'b'], targetIndex: 0, kind: 'top' })).toEqual({
      type: 'insert',
      index: 0,
      layout: 'main-side'
    })
  })

  it('turns three panes into a 2x2', () => {
    expect(planDrop({ ...grid, paneIds: ['a', 'b', 'c'], targetIndex: 2, kind: 'bottom' })).toEqual(
      { type: 'insert', index: 3, layout: 'grid-2x2' }
    )
    expect(planDrop({ ...grid, paneIds: ['a', 'b', 'c'], targetIndex: 0, kind: 'top' })).toEqual({
      type: 'insert',
      index: 0,
      layout: 'grid-2x2'
    })
  })

  it('degrades to a pair of columns when a single pane is stacked onto', () => {
    // Two panes have no vertical shape in this app; losing the drop would be worse
    // than giving the split, and you never fall into the grid by accident this way.
    expect(planDrop({ ...grid, paneIds: ['a'], targetIndex: 0, kind: 'bottom' })).toEqual({
      type: 'insert',
      index: 1,
      layout: 'cols-2'
    })
  })

  it('never makes a fourth column: a side drop onto three panes replaces instead', () => {
    // maxPanes is 4 here, so the capacity is there — but a cols-4 layout is not.
    expect(planDrop({ ...grid, paneIds: ['a', 'b', 'c'], targetIndex: 1, kind: 'right' })).toEqual({
      type: 'replace',
      index: 1
    })
  })

  it('collapses the vertical zones too once there is no capacity left', () => {
    expect(
      planDrop({ ...grid, paneIds: ['a', 'b', 'c', 'd'], targetIndex: 2, kind: 'top' })
    ).toEqual({ type: 'replace', index: 2 })
    expect(
      planDrop({ ...grid, paneIds: ['a', 'b', 'c', 'd'], targetIndex: 2, kind: 'bottom' })
    ).toEqual({ type: 'replace', index: 2 })
  })

  it('keeps the no-duplication invariant in the vertical zones', () => {
    expect(
      planDrop({ ...grid, sessionId: 'b', paneIds: ['a', 'b'], targetIndex: 0, kind: 'top' })
    ).toEqual({ type: 'focus', sessionId: 'b' })
    expect(
      planDrop({ ...grid, sessionId: 'a', paneIds: ['a', 'b'], targetIndex: 0, kind: 'bottom' })
    ).toEqual({ type: 'none' })
  })

  it('still respects a maxPanes lower than the grid capacity', () => {
    // A caller that can only draw three panes gets main-side, never a 2x2.
    expect(planDrop({ ...base, paneIds: ['a', 'b', 'c'], targetIndex: 0, kind: 'top' })).toEqual({
      type: 'replace',
      index: 0
    })
  })
})
