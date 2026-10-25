import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  clickRow,
  isolateRow,
  keepOnly,
  NO_SELECTION,
  replaceRows,
  selectedPart,
  setRows,
  useControlledSelection,
  useRangeSelection,
  wouldExceed,
  type Selection,
} from './range-selection'

const ROWS = ['a', 'b', 'c', 'd', 'e', 'f']

/** The selection after each click in turn, `+` marking those with Shift held. */
function clicks(...keys: string[]): Selection {
  return keys.reduce(
    (state, key) => clickRow(state, ROWS, key.replace('+', ''), key.startsWith('+')),
    NO_SELECTION,
  )
}

const selected = (state: Selection) => [...state.selected].sort()

describe('clickRow (AR10)', () => {
  it('toggles the row clicked, which becomes the anchor', () => {
    expect(clicks('b')).toEqual({ selected: new Set(['b']), anchor: 'b' })
    expect(clicks('b', 'b')).toEqual({ selected: new Set(), anchor: 'b' })
  })

  it('gives every row from the anchor to one clicked with Shift its new state', () => {
    expect(selected(clicks('b', '+e'))).toEqual(['b', 'c', 'd', 'e'])
    // Upwards too.
    expect(selected(clicks('e', '+b'))).toEqual(['b', 'c', 'd', 'e'])
  })

  it('moves the anchor to the row clicked with Shift', () => {
    expect(clicks('b', '+e').anchor).toBe('e')
    expect(selected(clicks('b', '+e', '+f'))).toEqual(['b', 'c', 'd', 'e', 'f'])
  })

  it('deselects a range when the row clicked with Shift was selected', () => {
    // An overshoot to F, undone from E: B to D are left.
    expect(selected(clicks('b', '+f', '+e'))).toEqual(['b', 'c', 'd'])
    // Every row, then C to E deselected.
    const all = setRows(NO_SELECTION, ROWS, true)
    const state = clickRow(clickRow(all, ROWS, 'c', false), ROWS, 'e', true)
    expect(selected(state)).toEqual(['a', 'b', 'f'])
  })

  it('leaves the rows that are not shown as they are', () => {
    const start = setRows(NO_SELECTION, ['c', 'x'], true)
    const shown = ['a', 'b', 'd', 'e']
    const state = clickRow(clickRow(start, shown, 'a', false), shown, 'e', true)
    expect(selected(state)).toEqual(['a', 'b', 'c', 'd', 'e', 'x'])
  })

  it('acts as a plain click without an anchor among the rows shown', () => {
    expect(selected(clicks('+d'))).toEqual(['d'])
    const anchored = clickRow(NO_SELECTION, ['x', ...ROWS], 'x', false)
    expect(selected(clickRow(anchored, ROWS, 'c', true))).toEqual(['c', 'x'])
  })
})

describe('isolateRow (GR7, CP2)', () => {
  // Neither x, which is selected, nor y, which is not, is shown: they never change.
  const SHOWN = ['a', 'b', 'c']
  const isolate = (selected: string[], key: string, inverted = false) =>
    [...isolateRow(new Set(selected), SHOWN, key, inverted)].sort()

  it('selects only the row among those shown, or all of them once it is the only one', () => {
    expect(isolate(['a', 'b', 'x'], 'c')).toEqual(['c', 'x'])
    expect(isolate(['a', 'b', 'x'], 'a')).toEqual(['a', 'x'])
    expect(isolate(['c', 'x'], 'c')).toEqual(['a', 'b', 'c', 'x'])
    expect(isolate([], 'b')).toEqual(['b'])
  })

  it('in a list whose selection is of the rows hidden, hides the others, or shows them all', () => {
    expect(isolate(['x'], 'c', true)).toEqual(['a', 'b', 'x'])
    expect(isolate(['a', 'b', 'c', 'x'], 'c', true)).toEqual(['a', 'b', 'x'])
    // c is the only row shown that is not hidden.
    expect(isolate(['a', 'b', 'x'], 'c', true)).toEqual(['x'])
    expect(isolate(['b', 'x'], 'a', true)).toEqual(['b', 'c', 'x'])
  })
})

describe('setRows', () => {
  it('selects or deselects the rows given, leaving the anchor', () => {
    const state = setRows(clicks('a'), ['c', 'd'], true)
    expect(state).toEqual({ selected: new Set(['a', 'c', 'd']), anchor: 'a' })
    expect(selected(setRows(state, ['a', 'c'], false))).toEqual(['d'])
  })
})

describe('replaceRows', () => {
  it('selects exactly the rows given, leaving the anchor', () => {
    expect(replaceRows(clicks('a', 'b'), ['c'])).toEqual({ selected: new Set(['c']), anchor: 'b' })
  })
})

describe('wouldExceed', () => {
  const limit = { count: 2, why: 'At most 2.' }

  it('says whether selecting rows as well would take the selection past the limit', () => {
    expect(wouldExceed(new Set(['a']), ['b'], limit)).toBe(false)
    expect(wouldExceed(new Set(['a']), ['b', 'c'], limit)).toBe(true)
    // Rows already selected add nothing.
    expect(wouldExceed(new Set(['a', 'b']), ['a', 'b'], limit)).toBe(false)
  })

  it('never says so without a limit', () => {
    expect(wouldExceed(new Set(ROWS), ['x', 'y'], null)).toBe(false)
  })
})

describe('keepOnly', () => {
  it('drops the rows not kept, and is the same selection when it drops none', () => {
    const state = clicks('a', '+c')
    expect(selected(keepOnly(state, new Set(['b', 'z'])))).toEqual(['b'])
    expect(keepOnly(state, new Set(ROWS))).toBe(state)
  })
})

describe('selectedPart', () => {
  it('says whether none, some or all of the rows shown are selected', () => {
    expect(selectedPart(new Set(), ['a'])).toBe('none')
    expect(selectedPart(new Set(['a', 'z']), ['a', 'b'])).toBe('some')
    expect(selectedPart(new Set(['a', 'b']), ['a', 'b'])).toBe('all')
  })
})

describe('useRangeSelection', () => {
  it('selects among the rows shown when a checkbox is clicked', () => {
    const { result, rerender } = renderHook(({ shown }) => useRangeSelection(undefined, shown), {
      initialProps: { shown: ROWS },
    })
    act(() => result.current.rows.click('a', false))
    rerender({ shown: ['a', 'c', 'e'] })
    act(() => result.current.rows.click('e', true))

    expect([...result.current.selected].sort()).toEqual(['a', 'c', 'e'])
  })

  it('keeps its rows object, for checkboxes to subscribe to', () => {
    const { result } = renderHook(() => useRangeSelection(undefined, ROWS))
    const { rows } = result.current
    act(() => rows.click('a', false))
    expect(result.current.rows).toBe(rows)
    expect(rows.selected()).toEqual(new Set(['a']))
  })

  it('deselects the rows no longer offered, once that is known', () => {
    const { result, rerender } = renderHook(
      ({ offered }: { offered: string[] | undefined }) => useRangeSelection(offered, ROWS),
      { initialProps: { offered: ROWS as string[] | undefined } },
    )
    act(() => result.current.rows.setRows(['a', 'b', 'c'], true))

    // Not while it is not known.
    rerender({ offered: undefined })
    expect(result.current.selected.size).toBe(3)
    rerender({ offered: ['b', 'c', 'd'] })
    expect([...result.current.selected].sort()).toEqual(['b', 'c'])
  })

  it('selects or deselects rows on request, whether shown or not', () => {
    const { result } = renderHook(() => useRangeSelection(undefined, ['a']))
    act(() => result.current.rows.setRows(['a', 'b'], true))
    expect(result.current.selected).toEqual(new Set(['a', 'b']))
    act(() => result.current.rows.setRows(new Set(['a', 'b']), false))
    expect(result.current.selected.size).toBe(0)
  })

  it('starts with the rows given, the first ones within the limit', () => {
    const limit = { count: 2, why: 'At most 2.' }
    const { result } = renderHook(() =>
      useRangeSelection(undefined, ROWS, { initial: ['c', 'c', 'a', 'e'], limit }),
    )
    // A row given twice counts once.
    expect(result.current.selected).toEqual(new Set(['c', 'a']))
  })

  it('holds no more rows than its limit, whatever is asked of it', () => {
    const limit = { count: 2, why: 'At most 2.' }
    const { result } = renderHook(() => useRangeSelection(undefined, ROWS, { limit }))
    const { rows } = result.current
    expect(rows.limit()).toBe(limit)

    act(() => rows.click('a', false))
    act(() => rows.click('d', true))
    act(() => rows.setRows(['b', 'c'], true))
    act(() => rows.replace(['b', 'c', 'd']))
    expect(result.current.selected).toEqual(new Set(['a']))

    // The refused range left the anchor at A: a range from it within the limit is taken.
    act(() => rows.click('b', true))
    expect(result.current.selected).toEqual(new Set(['a', 'b']))
    // Deselecting is never refused, and neither is what stays within the limit.
    act(() => rows.click('a', false))
    act(() => rows.replace(['e', 'f']))
    expect(result.current.selected).toEqual(new Set(['e', 'f']))
  })

  describe('reports a change refused at a row (GR7)', () => {
    const limit = { count: 2, why: 'At most 2.' }
    /** A list of rows `shown` that has refused a range from A to D. */
    function refused() {
      const hook = renderHook(({ shown }) => useRangeSelection(undefined, shown, { limit }), {
        initialProps: { shown: ROWS },
      })
      const { rows } = hook.result.current
      act(() => rows.click('a', false))
      act(() => rows.click('d', true))
      return { ...hook, ...hook.result.current }
    }

    it('with the row, and how many rows it would have selected, each as a new one', () => {
      const { rows, refusal } = refused()
      const first = refusal.get()
      expect(first).toMatchObject({ key: 'd', count: 4 })
      act(() => rows.click('d', true))
      expect(refusal.get()).toMatchObject({ key: 'd', count: 4 })
      expect(refusal.get()?.id).not.toBe(first?.id)
      act(() => rows.replace(['b', 'c', 'e'], 'e'))
      expect(refusal.get()).toMatchObject({ key: 'e', count: 3 })
    })

    it('but not one that no row asked for', () => {
      const { result } = renderHook(() => useRangeSelection(undefined, ROWS, { limit }))
      const { rows, refusal } = result.current
      act(() => rows.setRows(['a', 'b', 'c'], true))
      act(() => rows.replace(['a', 'b', 'c']))
      expect(refusal.get()).toBeNull()
    })

    it('until the selection changes', () => {
      const { rows, refusal } = refused()
      act(() => rows.click('b', false))
      expect(refusal.get()).toBeNull()
    })

    it('until the rows shown change', () => {
      const { rerender, refusal } = refused()
      // The same rows, derived anew.
      rerender({ shown: [...ROWS] })
      expect(refusal.get()).not.toBeNull()
      rerender({ shown: ['a', 'd'] })
      expect(refusal.get()).toBeNull()
    })
  })
})

describe('useControlledSelection', () => {
  const sorted = (keys: ReadonlySet<string> | undefined) => keys && [...keys].sort()

  it('hands every change to its owner, a range at a time with Shift, and keeps nothing else', () => {
    const onChange = vi.fn()
    const { result } = renderHook(() => useControlledSelection(new Set(['a']), ROWS, onChange))
    act(() => result.current.click('c', false))
    expect(sorted(onChange.mock.lastCall?.[0])).toEqual(['a', 'c'])
    expect(sorted(result.current.selected())).toEqual(['a'])
    act(() => result.current.click('e', true))
    expect(sorted(onChange.mock.lastCall?.[0])).toEqual(['a', 'c', 'd', 'e'])
  })

  it('follows the selection its owner holds, as the same object', () => {
    const { result, rerender } = renderHook(
      ({ selected }) => useControlledSelection(selected, ROWS, () => {}),
      { initialProps: { selected: new Set(['a']) } },
    )
    const rows = result.current
    rerender({ selected: new Set(['b', 'c']) })
    expect(result.current).toBe(rows)
    expect(sorted(rows.selected())).toEqual(['b', 'c'])
  })
})
