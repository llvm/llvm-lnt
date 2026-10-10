import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  clickRow,
  keepOnly,
  NO_SELECTION,
  selectedPart,
  setRows,
  useRangeSelection,
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

describe('clickRow (AR2 "Range selection")', () => {
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

describe('setRows', () => {
  it('selects or deselects the rows given, leaving the anchor', () => {
    const state = setRows(clicks('a'), ['c', 'd'], true)
    expect(state).toEqual({ selected: new Set(['a', 'c', 'd']), anchor: 'a' })
    expect(selected(setRows(state, ['a', 'c'], false))).toEqual(['d'])
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
})
