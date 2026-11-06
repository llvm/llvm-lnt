/**
 * Reordering a list by dragging its items by a grip (⠿), with a mouse, by touch, or from the
 * keyboard, through react-aria's drag and drop (AR24): Enter on a grip picks its item up, at its
 * own place, Tab and Shift+Tab go through the places it can go, Enter drops it there, and Escape
 * cancels. react-aria announces each step to assistive technology.
 *
 * An item is dropped on another, whose place it takes: before it when it comes from after it, and
 * after it otherwise. So every place can be reached, a drop indicator shows on that side, and the
 * keyboard needs no target of its own between items. Dropped on itself, it stays where it is.
 *
 * `Reorderable` holds the list's drag, `ReorderGrip` drags an item, and `useReorderTarget` makes
 * an item's element a drop target. The list's own markup is left to its page, such as table
 * rows.
 */

import { useRef, useState, type ReactNode } from 'react'
import { DragPreview, mergeProps, useButton, useDrag, type DragPreviewRenderer } from 'react-aria'
import { ReorderContext, useReorderState } from './drag-reorder-target'
import styles from './drag-reorder.module.css'

/** How many lists there have been, so that each has a drag type of its own. */
let lists = 0

/**
 * A list whose items, `keys` in their order, can be dragged into another order: `onMove` is to move
 * the item `key` to the place of `target`. `labelOf` names an item to assistive technology, as in
 * `Drag {label}`, and in the drag preview.
 */
export function Reorderable({
  keys,
  labelOf,
  onMove,
  children,
}: {
  keys: readonly string[]
  labelOf(key: string): string
  onMove(key: string, target: string): void
  children: ReactNode
}) {
  const [type] = useState(() => `application/x-lnt-reorder-${++lists}`)
  const [dragging, setDragging] = useState<string | null>(null)
  const preview = useRef<DragPreviewRenderer>(null)
  return (
    <ReorderContext value={{ type, keys, labelOf, dragging, setDragging, preview, onMove }}>
      {children}
      {/* What follows the pointer: the item's label, rather than the grip alone. */}
      <DragPreview ref={preview}>
        {(items) => <div className={styles.preview}>{labelOf(items[0]?.[type] ?? '')}</div>}
      </DragPreview>
    </ReorderContext>
  )
}

interface GripProps {
  itemKey: string
  /** What the list is busy with is under way: the grip cannot drag, but keeps the focus. */
  busy?: boolean
  'data-focus'?: string
}

/** The grip dragging the item `itemKey` (see the top of this file). */
export function ReorderGrip({ itemKey, busy = false, ...props }: GripProps) {
  const { type, labelOf, preview, setDragging } = useReorderState()
  const label = labelOf(itemKey)
  const ref = useRef<HTMLSpanElement>(null)
  const { dragProps, dragButtonProps } = useDrag({
    hasDragButton: true,
    isDisabled: busy,
    preview,
    // Of the list's own type alone: an input would take `text/plain` dropped on it as text to
    // insert.
    getItems: () => [{ [type]: itemKey }],
    getAllowedDropOperations: () => ['move'],
    onDragStart: () => setDragging(itemKey),
    onDragEnd: () => setDragging(null),
  })
  const { buttonProps } = useButton(
    { ...dragButtonProps, elementType: 'span', 'aria-label': `Drag ${label}` },
    ref,
  )
  return (
    <span
      ref={ref}
      {...mergeProps(dragProps, buttonProps)}
      {...props}
      aria-disabled={busy || undefined}
      className={styles.grip}
    >
      ⠿
    </span>
  )
}
