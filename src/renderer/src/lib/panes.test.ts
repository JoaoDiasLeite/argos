import { describe, it, expect } from 'vitest'
import {
  capacity,
  emptyState,
  openInFocused,
  openInNewPane,
  closePane,
  setFocus,
  setLayout,
  setSizes,
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

  it('round-trips valid sizes, normalized to sum to 1', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
        focused: 'a',
        sizes: { cols: [1, 3] }
      },
      known
    )
    expect(result.sizes?.cols).toEqual([0.25, 0.75])
  })

  it('drops an axis whose length does not match the sanitized pane count', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-3',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }],
        focused: 'a',
        // Two fractions for three panes — length mismatch.
        sizes: { cols: [0.5, 0.5] }
      },
      known
    )
    expect(result.sizes).toBeUndefined()
  })

  it('drops an axis containing a NaN', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
        focused: 'a',
        sizes: { cols: [NaN, 1] }
      },
      known
    )
    expect(result.sizes).toBeUndefined()
  })

  it('drops an axis containing a zero', () => {
    const result = normalize(
      {
        v: 1,
        layout: 'cols-2',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
        focused: 'a',
        sizes: { cols: [0, 1] }
      },
      known
    )
    expect(result.sizes).toBeUndefined()
  })

  it('drops an axis whose length matched the raw panes but not the sanitized ones', () => {
    // Three raw panes, one of them a ghost session — sanitizing drops it to two,
    // so a three-long cols axis (valid against the raw list) must still be dropped.
    const result = normalize(
      {
        v: 1,
        layout: 'cols-3',
        panes: [{ sessionId: 'a' }, { sessionId: 'ghost' }, { sessionId: 'b' }],
        focused: 'a',
        sizes: { cols: [1, 1, 1] }
      },
      known
    )
    expect(result.sizes).toBeUndefined()
  })
})

describe('setSizes', () => {
  const base: PaneState = {
    v: 1,
    layout: 'cols-2',
    panes: [{ sessionId: 'a' }, { sessionId: 'b' }],
    focused: 'a'
  }

  it('sets and normalizes the cols axis, leaving the rest untouched', () => {
    const frozen = structuredClone(base)
    const result = setSizes(base, { cols: [1, 1] })
    expect(result.sizes).toEqual({ cols: [0.5, 0.5] })
    expect(result.panes).toEqual(base.panes)
    expect(base).toEqual(frozen)
  })

  it('normalizes an uneven split', () => {
    const result = setSizes(base, { cols: [1, 4] })
    expect(result.sizes?.cols).toEqual([0.2, 0.8])
  })

  it('drops sizes entirely when given an empty axis and nothing else', () => {
    const withSizes = setSizes(base, { cols: [0.5, 0.5] })
    const result = setSizes(withSizes, { cols: [] })
    expect(result.sizes).toBeUndefined()
  })
})

describe('sizes discarded on pane-count changes', () => {
  it('closePane drops the cols axis', () => {
    const withSizes = setSizes(
      { v: 1, layout: 'cols-3', panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }], focused: 'a' },
      { cols: [0.2, 0.3, 0.5] }
    )
    const result = closePane(withSizes, 'b')
    expect(result.sizes).toBeUndefined()
  })

  it('openInNewPane drops the cols axis when it appends a pane', () => {
    const withSizes = setSizes(
      { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }], focused: 'a' },
      { cols: [1] }
    )
    const result = openInNewPane(withSizes, 'b')
    expect(result.sizes).toBeUndefined()
  })

  it('openInNewPane keeps sizes when it only moves focus to an already-open pane', () => {
    const withSizes = setSizes(
      { v: 1, layout: 'cols-2', panes: [{ sessionId: 'a' }, { sessionId: 'b' }], focused: 'a' },
      { cols: [0.3, 0.7] }
    )
    const result = openInNewPane(withSizes, 'b')
    expect(result.sizes?.cols).toEqual([0.3, 0.7])
  })

  it('setLayout drops the cols axis when it trims panes', () => {
    const withSizes = setSizes(
      {
        v: 1,
        layout: 'grid-2x2',
        panes: [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }, { sessionId: 'd' }],
        focused: 'a'
      },
      { cols: [0.25, 0.25, 0.25, 0.25] }
    )
    const result = setLayout(withSizes, 'cols-2')
    expect(result.sizes).toBeUndefined()
  })

  it('setLayout keeps sizes when the pane count does not change', () => {
    const withSizes = setSizes(
      { v: 1, layout: 'single', panes: [{ sessionId: 'a' }], focused: 'a' },
      { cols: [1] }
    )
    const result = setLayout(withSizes, 'cols-3')
    expect(result.sizes?.cols).toEqual([1])
  })
})
