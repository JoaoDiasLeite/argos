import { describe, it, expect } from 'vitest'
import {
  capacity,
  emptyState,
  openInFocused,
  openInNewPane,
  closePane,
  setFocus,
  setLayout,
  normalize,
  type PaneState
} from './panes'

describe('capacity', () => {
  it('matches each layout its number of slots', () => {
    expect(capacity('single')).toBe(1)
    expect(capacity('cols-2')).toBe(2)
    expect(capacity('cols-3')).toBe(3)
    expect(capacity('grid-2x2')).toBe(4)
    expect(capacity('main-side')).toBe(3)
  })
})

describe('openInFocused', () => {
  it('an empty sessionId clears every pane but keeps the layout', () => {
    const state: PaneState = { v: 1, layout: 'cols-3', panes: [{ sessionId: 'a' }], focused: 'a' }
    const frozen = structuredClone(state)
    const result = openInFocused(state, '')
    expect(result).toEqual({ v: 1, layout: 'cols-3', panes: [], focused: '' })
    expect(state).toEqual(frozen)
  })

  it('moves focus instead of duplicating a session already open elsewhere', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'a'
    }
    const result = openInFocused(state, 'b')
    expect(result.panes).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }])
    expect(result.focused).toBe('b')
  })

  it('creates the first pane when there are none', () => {
    const result = openInFocused(emptyState(), 'a')
    expect(result.panes).toEqual([{ sessionId: 'a' }])
    expect(result.focused).toBe('a')
  })

  it('replaces the focused pane session in place otherwise', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'b'
    }
    const frozen = structuredClone(state)
    const result = openInFocused(state, 'c')
    expect(result.panes).toEqual([{ sessionId: 'a' }, { sessionId: 'c' }])
    expect(result.focused).toBe('c')
    expect(state).toEqual(frozen)
  })
})

describe('openInNewPane', () => {
  it('does not duplicate a session already open, just refocuses it', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'a'
    }
    const result = openInNewPane(state, 'b')
    expect(result.panes.length).toBe(2)
    expect(result.focused).toBe('b')
  })

  it('appends a pane when there is room', () => {
    const state: PaneState = { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' }
    const result = openInNewPane(state, 'b')
    expect(result.panes).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }])
    expect(result.layout).toBe('cols-2')
    expect(result.focused).toBe('b')
  })

  it('grows the layout one step when full', () => {
    const state: PaneState = {
      v: 1,
      layout: 'single',
      panes: [{ sessionId: 'a' }],
      focused: 'a'
    }
    const result = openInNewPane(state, 'b')
    expect(result.layout).toBe('cols-2')
    expect(result.panes.map((p) => p.sessionId)).toEqual(['a', 'b'])
  })

  it('replaces the focused pane when already at the top layout', () => {
    const state: PaneState = {
      v: 1,
      layout: 'grid-2x2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }],
      focused: 'c'
    }
    const result = openInNewPane(state, 'e')
    expect(result.layout).toBe('grid-2x2')
    expect(result.panes.map((p) => p.sessionId)).toEqual(['a', 'b', 'e', 'd'])
    expect(result.focused).toBe('e')
  })
})

describe('closePane', () => {
  it('focuses the previous pane when the focused one closes', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-3',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
      focused: 'b'
    }
    const frozen = structuredClone(state)
    const result = closePane(state, 'b')
    expect(result.panes.map((p) => p.sessionId)).toEqual(['a', 'c'])
    expect(result.focused).toBe('a')
    expect(state).toEqual(frozen)
  })

  it('focuses the new first pane when index 0 was focused and closes', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'a'
    }
    const result = closePane(state, 'a')
    expect(result.panes.map((p) => p.sessionId)).toEqual(['b'])
    expect(result.focused).toBe('b')
  })

  it('leaves focus untouched when the closed pane was not focused', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'a'
    }
    const result = closePane(state, 'b')
    expect(result.focused).toBe('a')
  })

  it('returns to single with no panes and no focus once it empties out', () => {
    const state: PaneState = { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' }
    const result = closePane(state, 'a')
    expect(result).toEqual({ v: 1, layout: 'single', panes: [], focused: '' })
  })

  it('is a no-op for a session that is not open', () => {
    const state: PaneState = { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' }
    expect(closePane(state, 'z')).toEqual(state)
  })
})

describe('setFocus', () => {
  it('focuses a session that is actually in a pane', () => {
    const state: PaneState = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
      focused: 'a'
    }
    expect(setFocus(state, 'b').focused).toBe('b')
  })

  it('leaves the state unchanged when the session has no pane', () => {
    const state: PaneState = { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' }
    expect(setFocus(state, 'z')).toEqual(state)
  })
})

describe('setLayout', () => {
  it('trims excess panes from the end, keeping the focused one', () => {
    const state: PaneState = {
      v: 1,
      layout: 'grid-2x2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }],
      focused: 'd'
    }
    const frozen = structuredClone(state)
    const result = setLayout(state, 'cols-2')
    expect(result.panes.length).toBe(2)
    expect(result.panes.some((p) => p.sessionId === 'd')).toBe(true)
    expect(result.focused).toBe('d')
    expect(state).toEqual(frozen)
  })

  it('keeps the panes and just swaps the layout when there is room', () => {
    const state: PaneState = { v: 1, layout: 'single', panes: [{ sessionId: 'a' }], focused: 'a' }
    const result = setLayout(state, 'cols-3')
    expect(result.panes).toEqual([{ sessionId: 'a' }])
    expect(result.layout).toBe('cols-3')
  })

  it('falls back to the first pane when the focused one is not among the trimmed panes', () => {
    const state: PaneState = {
      v: 1,
      layout: 'grid-2x2',
      panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }],
      focused: 'a'
    }
    const result = setLayout(state, 'single')
    expect(result.panes).toEqual([{ sessionId: 'a' }])
    expect(result.focused).toBe('a')
  })
})

describe('normalize', () => {
  const known = ['a', 'b', 'c']

  it('recovers from a wrong v', () => {
    const result = normalize({ v: 99, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' }, known)
    expect(result.v).toBe(1)
    expect(result.panes).toEqual([{ sessionId: 'a' }])
  })

  it('falls back to single on an unknown layout', () => {
    const result = normalize(
      { v: 1, layout: 'nonsense', panes: [{ sessionId: 'a' }], focused: 'a' },
      known
    )
    expect(result.layout).toBe('single')
  })

  it('treats a non-array panes as empty', () => {
    expect(normalize({ v: 1, layout: 'cols-2', panes: 'oops', focused: '' }, known)).toEqual(
      emptyState()
    )
  })

  it('drops panes whose session no longer exists', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'ghost' }],
        focused: 'a'
      },
      known
    )
    expect(result.panes).toEqual([{ sessionId: 'a' }])
  })

  it('deduplicates, keeping the first occurrence', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'a' }, { sessionId: 'b' }],
        focused: 'b'
      },
      known
    )
    expect(result.panes).toEqual([{ sessionId: 'a' }, { sessionId: 'b' }])
  })

  it('cuts to the capacity of the layout', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
        focused: 'a'
      },
      known
    )
    expect(result.panes.length).toBe(2)
  })

  it('picks the first pane as focus when focused points nowhere', () => {
    const result = normalize(
      { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }, { sessionId: 'b' }], focused: 'ghost' },
      known
    )
    expect(result.focused).toBe('a')
  })

  it('never throws on outright garbage and settles on emptyState', () => {
    expect(normalize(null, known)).toEqual(emptyState())
    expect(normalize(undefined, known)).toEqual(emptyState())
    expect(normalize('garbage', known)).toEqual(emptyState())
    expect(normalize(42, known)).toEqual(emptyState())
    expect(normalize({}, known)).toEqual(emptyState())
    expect(normalize({ panes: [{}, { sessionId: 123 }, { sessionId: '' }] }, known)).toEqual(
      emptyState()
    )
  })

  it('does not mutate the input it is given', () => {
    const input = {
      v: 1,
      layout: 'cols-2',
      panes: [{ sessionId: 'a' }, { sessionId: 'a' }],
      focused: 'a'
    }
    const frozen = structuredClone(input)
    normalize(input, known)
    expect(input).toEqual(frozen)
  })
})
