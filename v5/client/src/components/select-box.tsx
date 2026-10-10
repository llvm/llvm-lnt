import { useLayoutEffect, useRef, useSyncExternalStore, type MouseEvent } from 'react'
import { selectedPart, type RowSelection } from './range-selection'
import styles from './select-box.module.css'

interface SelectBoxProps {
  rows: RowSelection
  /** The key of the checkbox's row. */
  rowKey: string
  /** The checkbox's accessible name: what the row is. */
  label: string
}

/**
 * The checkbox selecting a row of a list (see `useRangeSelection`), with Shift held to select a
 * range (AR2 "Range selection"). It renders again on its own when its row is selected or
 * deselected, rather than with the whole list.
 */
export function SelectBox({ rows, rowKey, label }: SelectBoxProps) {
  const checked = useSyncExternalStore(rows.subscribe, () => rows.selected().has(rowKey))
  return (
    <input
      type="checkbox"
      className={styles.box}
      aria-label={label}
      checked={checked}
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
 * when they all are, and indeterminate when only some are.
 */
export function SelectAllBox({ rows, shown, label }: SelectAllBoxProps) {
  const part = useSyncExternalStore(rows.subscribe, () => selectedPart(rows.selected(), shown))
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
      disabled={shown.length === 0}
      onChange={() => rows.setRows(shown, part !== 'all')}
    />
  )
}
