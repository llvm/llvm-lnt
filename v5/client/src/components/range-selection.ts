import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * A selection among the rows of a list, each with a checkbox, and the anchor that a range selected
 * with Shift starts from (AR2 "Range selection"). Rows are identified by string keys.
 */
export interface Selection {
  selected: ReadonlySet<string>
  /** The row whose checkbox was clicked last, or null if none has been. */
  anchor: string | null
}

export const NO_SELECTION: Selection = { selected: new Set(), anchor: null }

/**
 * The selection once the row `key` is clicked, among the rows `shown`, in order: the row is
 * toggled, and with `shift`, so is every row shown between the anchor and it, to the row's new
 * state. Without an anchor among the rows shown, a click with Shift is a plain click. Either way,
 * the row becomes the anchor.
 */
export function clickRow(
  { selected, anchor }: Selection,
  shown: readonly string[],
  key: string,
  shift: boolean,
): Selection {
  const select = !selected.has(key)
  const to = shown.indexOf(key)
  const from = shift && anchor !== null ? shown.indexOf(anchor) : -1
  const range =
    from >= 0 && to >= 0 ? shown.slice(Math.min(from, to), Math.max(from, to) + 1) : [key]
  return { selected: withRows(selected, range, select), anchor: key }
}

/** The selection once every one of `keys` is selected, or deselected: the anchor stays. */
export function setRows(state: Selection, keys: Iterable<string>, select: boolean): Selection {
  return { ...state, selected: withRows(state.selected, keys, select) }
}

/** The selection without the rows `keep` lacks: `state` itself if it loses none. */
export function keepOnly(state: Selection, keep: ReadonlySet<string>): Selection {
  const kept = [...state.selected].filter((key) => keep.has(key))
  return kept.length === state.selected.size ? state : { ...state, selected: new Set(kept) }
}

function withRows(selected: ReadonlySet<string>, keys: Iterable<string>, select: boolean) {
  const next = new Set(selected)
  for (const key of keys) {
    if (select) next.add(key)
    else next.delete(key)
  }
  return next
}

/** How much of a list is selected, for the checkbox in its header. */
export type SelectedPart = 'none' | 'some' | 'all'

/** How many of the rows `shown` are selected: none, some or all of them. */
export function selectedPart(
  selected: ReadonlySet<string>,
  shown: readonly string[],
): SelectedPart {
  let count = 0
  for (const key of shown) if (selected.has(key)) count++
  if (count === 0) return 'none'
  return count === shown.length ? 'all' : 'some'
}

/**
 * The selection of a list, for its rows' checkboxes (see `SelectBox` and `SelectAllBox`). It is the
 * same object for as long as the list is shown, so that a table holding the checkboxes need not
 * render again when the selection changes: each checkbox renders again on its own, when its row is
 * selected or deselected.
 */
export interface RowSelection {
  subscribe(listener: () => void): () => void
  selected(): ReadonlySet<string>
  /** The row `key` was clicked, with Shift held or not (see `clickRow`). */
  click(key: string, shift: boolean): void
  /** Select every one of `keys`, or none of them, whether shown or not. */
  setRows(keys: Iterable<string>, select: boolean): void
}

export interface RangeSelection {
  selected: ReadonlySet<string>
  rows: RowSelection
}

class SelectionStore {
  private state = NO_SELECTION
  private readonly listeners = new Set<() => void>()

  get = () => this.state

  set = (next: Selection) => {
    if (next === this.state) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/**
 * A selection among the rows of a list (AR2 "Range selection"). `shown` are the rows in view, in
 * order, which a range selected with Shift spans. `offered` are the rows that can be selected, or
 * undefined while that is not known: once it is, a row that is no longer offered is deselected, so
 * that it does not come back with the row. A list whose filter is to deselect the rows it hides
 * passes the rows it shows as `offered`.
 */
export function useRangeSelection(
  offered: readonly string[] | undefined,
  shown: readonly string[],
): RangeSelection {
  const [store] = useState(() => new SelectionStore())
  const { selected } = useSyncExternalStore(store.subscribe, store.get)

  // The rows shown when a checkbox is clicked, rather than when the handlers were created, so that
  // they keep their identity.
  const shownRef = useRef(shown)
  useLayoutEffect(() => {
    shownRef.current = shown
  })
  // Before the page is painted, so that what is no longer offered is never shown selected.
  useLayoutEffect(() => {
    if (offered !== undefined) store.set(keepOnly(store.get(), new Set(offered)))
  }, [offered, store])

  const [rows] = useState<RowSelection>(() => ({
    subscribe: store.subscribe,
    selected: () => store.get().selected,
    click: (key, shift) => store.set(clickRow(store.get(), shownRef.current, key, shift)),
    setRows: (keys, select) => store.set(setRows(store.get(), keys, select)),
  }))
  return { selected, rows }
}
