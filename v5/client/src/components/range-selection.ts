import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

/**
 * A selection among the rows of a list, each with a checkbox, and the anchor that a range selected
 * with Shift starts from (AR10). Rows are identified by string keys.
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

/** The selection once it is exactly `keys`: the anchor stays. */
export function replaceRows(state: Selection, keys: Iterable<string>): Selection {
  return { ...state, selected: new Set(keys) }
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

/** How many rows a list lets the user select at once, and why, for its disabled checkboxes. */
export interface SelectionLimit {
  count: number
  /** Why no more rows can be selected, said on hover, e.g. `At most 100 tests can be selected.` */
  why: string
}

/** Whether selecting `keys` as well would take `selected` past `limit`, if there is one. */
export function wouldExceed(
  selected: ReadonlySet<string>,
  keys: Iterable<string>,
  limit: SelectionLimit | null,
): boolean {
  if (limit === null) return false
  let size = selected.size
  for (const key of keys) if (!selected.has(key) && ++size > limit.count) return true
  return false
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
  /** The list's limit, if it has one. */
  limit(): SelectionLimit | null
  /**
   * The row `key` was clicked, with Shift held or not (see `clickRow`). Like the other changes
   * below, it does nothing, anchor included, when it would select more rows than the limit.
   */
  click(key: string, shift: boolean): void
  /** Select every one of `keys`, or none of them, whether shown or not. */
  setRows(keys: Iterable<string>, select: boolean): void
  /** Select exactly `keys`, whether shown or not (see `replaceRows`). */
  replace(keys: Iterable<string>): void
}

export interface RangeSelection {
  selected: ReadonlySet<string>
  rows: RowSelection
}

class SelectionStore {
  private state: Selection
  constructor(initial: Selection) {
    this.state = initial
  }
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

interface Options {
  /** At most how many rows can be selected (GR7): nothing that would select more does anything. */
  limit?: SelectionLimit
  /**
   * The rows selected to begin with, such as those a URL names. Beyond `limit`, the first ones
   * are kept. Those that are not offered are deselected once that is known, like any other.
   */
  initial?: readonly string[]
}

/**
 * A selection among the rows of a list (AR10). `shown` are the rows in view, in order, which a
 * range selected with Shift spans. `offered` are the rows that can be selected, or undefined while
 * that is not known: once it is, a row that is no longer offered is deselected, so that it does not
 * come back with the row. A list whose filter is to deselect the rows it hides passes the rows it
 * shows as `offered`.
 */
export function useRangeSelection(
  offered: readonly string[] | undefined,
  shown: readonly string[],
  { limit, initial = [] }: Options = {},
): RangeSelection {
  const [store] = useState(
    () => new SelectionStore({ selected: new Set(initial.slice(0, limit?.count)), anchor: null }),
  )
  const { selected } = useSyncExternalStore(store.subscribe, store.get)

  // The rows shown when a checkbox is clicked, rather than when the handlers were created, so that
  // they keep their identity.
  const shownRef = useRef(shown)
  const limitRef = useRef(limit)
  useLayoutEffect(() => {
    shownRef.current = shown
    limitRef.current = limit
  })
  // Before the page is painted, so that what is no longer offered is never shown selected.
  useLayoutEffect(() => {
    if (offered !== undefined) store.set(keepOnly(store.get(), new Set(offered)))
  }, [offered, store])

  const [rows] = useState<RowSelection>(() => {
    // Every change goes through here, which refuses one that selects more rows than the limit.
    const change = (next: Selection) => {
      if (next.selected.size <= (limitRef.current?.count ?? Infinity)) store.set(next)
    }
    return {
      subscribe: store.subscribe,
      selected: () => store.get().selected,
      limit: () => limitRef.current ?? null,
      click: (key, shift) => change(clickRow(store.get(), shownRef.current, key, shift)),
      setRows: (keys, select) => change(setRows(store.get(), keys, select)),
      replace: (keys) => change(replaceRows(store.get(), keys)),
    }
  })
  return { selected, rows }
}
