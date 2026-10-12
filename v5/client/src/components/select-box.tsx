import { useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react'
import { selectedPart, wouldExceed, type RowSelection } from './range-selection'
import styles from './select-box.module.css'

interface SelectBoxProps {
  rows: RowSelection
  /** The key of the checkbox's row. */
  rowKey: string
  /** The checkbox's accessible name: what the row is. */
  label: string
}

/**
 * The state of a row's checkbox: checked, unchecked, or unchecked and disabled because selecting
 * its row would take the list past its limit. A string, since `useSyncExternalStore` compares
 * snapshots by identity.
 */
function boxState(rows: RowSelection, key: string): 'on' | 'off' | 'full' {
  const selected = rows.selected()
  if (selected.has(key)) return 'on'
  return wouldExceed(selected, [key], rows.limit()) ? 'full' : 'off'
}

/**
 * The checkbox selecting a row of a list (see `useRangeSelection`), with Shift held to select a
 * range (AR10). It renders again on its own when its row is selected or deselected, rather than
 * with the whole list. Once the list's limit is reached, it cannot select its row, and says why on
 * hover; the title is also its description for assistive technology, as `aria-label` names it.
 */
export function SelectBox({ rows, rowKey, label }: SelectBoxProps) {
  const state = useSyncExternalStore(rows.subscribe, () => boxState(rows, rowKey))
  return (
    <input
      type="checkbox"
      className={styles.box}
      aria-label={label}
      checked={state === 'on'}
      disabled={state === 'full'}
      title={state === 'full' ? rows.limit()?.why : undefined}
      // On click rather than change, for the modifier keys: a checkbox toggled from the keyboard
      // is clicked too, with Shift held or not.
      onClick={(event: MouseEvent) => rows.click(rowKey, event.shiftKey)}
      // The click handler changes the selection, which `checked` follows.
      onChange={() => {}}
    />
  )
}

interface SelectAllBoxProps {
  rows: RowSelection
  /** The keys of the rows shown, which the checkbox selects or deselects. */
  shown: readonly string[]
  /** The checkbox's accessible name, e.g. `Select all indicators`. */
  label: string
}

/**
 * The checkbox selecting every row shown of a list, or, once they all are, none of them: checked
 * when they all are, and indeterminate when only some are. It cannot select them all when that
 * would take the list past its limit, and says why on hover.
 */
export function SelectAllBox({ rows, shown, label }: SelectAllBoxProps) {
  const part = useSyncExternalStore(rows.subscribe, () => selectedPart(rows.selected(), shown))
  const full = useSyncExternalStore(rows.subscribe, () =>
    wouldExceed(rows.selected(), shown, rows.limit()),
  )
  const box = useRef<HTMLInputElement>(null)
  // Before the page is painted, so that the box never shows the wrong state.
  useLayoutEffect(() => {
    if (box.current) box.current.indeterminate = part === 'some'
  }, [part])
  return (
    <input
      ref={box}
      type="checkbox"
      className={styles.box}
      aria-label={label}
      checked={part === 'all'}
      disabled={shown.length === 0 || full}
      title={full ? rows.limit()?.why : undefined}
      onChange={() => rows.setRows(shown, part !== 'all')}
    />
  )
}
