/**
 * Reordering a list by dragging its items by a grip (⠿), with a mouse, by touch, or from the
 * keyboard, through react-aria's drag and drop (AR24): Enter on a grip picks its item up, at its
 * own place, Tab and Shift+Tab go through the places it can go, Enter drops it there, and Escape
 * cancels. react-aria announces each step to assistive technology.
 *
 * An item is dropped on another, whose place it takes: before it when it comes from after it, and
 * after it otherwise. So every place can be reached, a drop indicator shows on that side, and the
 * keyboard needs no target of its own between items. Dropped on itself, it stays where it is.
 * After a drop, the item's grip has the focus.
 *
 * `Reorderable` holds the list's drag, `ReorderGrip` drags an item, and `useReorderTarget` makes
 * an item's element a drop target. The list's own markup is left to its page, such as table rows.
 * `useSavedOrder` saves the new order on each drop.
 */

import {
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import { DragPreview, mergeProps, useButton, useDrag, type DragPreviewRenderer } from 'react-aria'
import { VisuallyHidden } from 'react-aria-components'
import { ReorderContext, useReorderState, type Orientation } from './drag-reorder-target'
import styles from './drag-reorder.module.css'

/** How many lists there have been, so that each has a drag type of its own. */
let lists = 0

interface ReorderableProps {
  keys: readonly string[]
  labelOf(key: string): string
  onMove(key: string, target: string): void
  orientation?: Orientation
  busy?: boolean
  saving?: string | null
  children: ReactNode
}

/**
 * A list whose items, `keys` in their order, can be dragged into another order: `onMove` is to move
 * the item `key` to the place of `target`. `labelOf` names an item to assistive technology, as in
 * `Drag {label}`, and in the drag preview. While `busy`, as when the order is being saved, no item
 * can be dragged, and the item `saving` is shown faded.
 *
 * After a drop, the grip of the item dropped takes the focus, once the list has rendered: react-aria
 * leaves it on the drop target, which stops being one as the drag ends. When the list's order
 * changes otherwise, as when a save fails and the item goes back, React keeps the focus on a grip
 * it moves.
 */
export function Reorderable({
  keys,
  labelOf,
  onMove,
  orientation = 'vertical',
  busy = false,
  saving = null,
  children,
}: ReorderableProps) {
  const [type] = useState(() => `application/x-lnt-reorder-${++lists}`)
  const [dragging, setDragging] = useState<string | null>(null)
  const preview = useRef<DragPreviewRenderer>(null)
  // The grip of the item being dragged. React keeps an item's elements as the list moves it, so it
  // stays the grip of its item.
  const draggedGrip = useRef<HTMLElement | null>(null)
  // The grip that takes the focus once the list has rendered after a drop.
  const dropped = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    dropped.current?.focus()
    dropped.current = null
  })

  // The latest `onMove`, so that the list's state need not change with it.
  const move = useRef(onMove)
  useLayoutEffect(() => {
    move.current = onMove
  })
  const onDrop = useCallback((key: string, target: string) => {
    dropped.current = draggedGrip.current
    if (key !== target) move.current(key, target)
  }, [])
  const onGripDrag = useCallback((grip: HTMLElement | null) => {
    draggedGrip.current = grip
  }, [])
  // The same for as long as what it holds is, so that the items, which read it, render again only
  // when it changes, such as a table's rows (see `DataTable`).
  const state = useMemo(
    () => ({
      type,
      keys,
      labelOf,
      orientation,
      busy,
      saving,
      dragging,
      setDragging,
      preview,
      onDrop,
      onGripDrag,
    }),
    [type, keys, labelOf, orientation, busy, saving, dragging, onDrop, onGripDrag],
  )
  return (
    <ReorderContext value={state}>
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
  /**
   * Why the item cannot be dragged, if it cannot, such as the scope it needs: the grip is disabled,
   * and says why on hover and to assistive technology (as AR17 has disabled controls do). Unlike a
   * grip of a busy list, a disabled one cannot take the focus.
   */
  reason?: string
}

/**
 * The grip dragging the item `itemKey` (see the top of this file). Its colours can be set by its
 * page, through `--reorder-grip-color` and the like (see drag-reorder.module.css).
 */
export function ReorderGrip({ itemKey, reason }: GripProps) {
  const { type, labelOf, busy, preview, setDragging, onGripDrag } = useReorderState()
  const disabled = reason !== undefined
  const reasonId = useId()
  const ref = useRef<HTMLSpanElement>(null)
  const { dragProps, dragButtonProps } = useDrag({
    hasDragButton: true,
    isDisabled: disabled || busy,
    preview,
    // Of the list's own type alone: an input would take `text/plain` dropped on it as text to
    // insert.
    getItems: () => [{ [type]: itemKey }],
    getAllowedDropOperations: () => ['move'],
    onDragStart: () => {
      onGripDrag(ref.current)
      setDragging(itemKey)
    },
    onDragEnd: () => setDragging(null),
  })
  const { buttonProps } = useButton(
    {
      ...dragButtonProps,
      elementType: 'span',
      isDisabled: disabled,
      'aria-label': `Drag ${labelOf(itemKey)}`,
    },
    ref,
  )
  return (
    <>
      <span
        ref={ref}
        {...mergeProps(dragProps, buttonProps)}
        aria-disabled={disabled || busy || undefined}
        title={reason}
        aria-describedby={disabled ? reasonId : undefined}
        className={clsx(styles.grip, disabled && styles.disabled)}
      >
        ⠿
      </span>
      {disabled && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
    </>
  )
}
