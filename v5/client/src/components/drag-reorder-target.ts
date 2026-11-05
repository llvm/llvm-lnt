/**
 * The state of a reorderable list (see `drag-reorder.tsx`), and the drop targets of its items,
 * which a page's own markup holds, such as table rows.
 */

import { createContext, use, type HTMLAttributes, type RefObject } from 'react'
import clsx from 'clsx'
import { useDrop, type DragPreviewRenderer } from 'react-aria'
import styles from './drag-reorder.module.css'

/** Where an item dropped on another goes: before it, or after it. */
export type DropPosition = 'before' | 'after'

/** How the items of a list are laid out: one above the other, or side by side. */
export type Orientation = 'vertical' | 'horizontal'

export interface ReorderState {
  /** The drag type of the list's items, which no other list's accept. */
  type: string
  keys: readonly string[]
  labelOf(key: string): string
  orientation: Orientation
  /** The new order of the list is being saved: no item can be dragged. */
  busy: boolean
  /** The item whose move is being saved, if any, which is shown faded. */
  saving: string | null
  /** The item being dragged, if any. */
  dragging: string | null
  setDragging(key: string | null): void
  preview: RefObject<DragPreviewRenderer | null>
  /** The item `key` was dropped on the item `target`, which is itself if it stays in its place. */
  onDrop(key: string, target: string): void
  /** The drag of an item starts from its grip, `grip`, which has the focus after a drop. */
  onGripDrag(grip: HTMLElement | null): void
}

export const ReorderContext = createContext<ReorderState | null>(null)

export function useReorderState(): ReorderState {
  const state = use(ReorderContext)
  if (state === null) throw new Error('A reorderable item is outside its Reorderable.')
  return state
}

/**
 * Make `element`, the item `itemKey`'s, a drop target while an item of its list is dragged, unless
 * `isDisabled`, as for an item that cannot move. Returns the element's attributes: while dragging,
 * its accessible name, `Before {label}` or `After {label}`, or `Leave {label} where it is` for the
 * item dragged, the focus that the keyboard gives it, and the classes of the drop indicator, and
 * of the item being dragged, or whose move is being saved.
 */
export function useReorderTarget({
  itemKey,
  element,
  isDisabled = false,
}: {
  itemKey: string
  element: RefObject<HTMLElement | null>
  isDisabled?: boolean
}): HTMLAttributes<HTMLElement> {
  const { type, keys, labelOf, orientation, saving, dragging, onDrop } = useReorderState()
  // A drop target only while an item is dragged. From the keyboard, react-aria goes through the
  // drop targets in the order they registered, not in the order they are shown in: registering
  // them all as a drag starts, as they render, makes the two the same, whatever moved before.
  // react-aria starts from the target holding the grip, if any, and from the nearest one on screen
  // otherwise, which would make the order depend on the layout: so the item dragged is a target
  // too, which leaves it where it is.
  const active = dragging !== null && !isDisabled
  const self = dragging === itemKey
  const { dropProps, isDropTarget } = useDrop({
    ref: element,
    isDisabled: !active,
    getDropOperation: (types) => (types.has(type) ? 'move' : 'cancel'),
    onDrop: () => {
      if (dragging !== null) onDrop(dragging, itemKey)
    },
  })
  if (dragging === null) return saving === itemKey ? { className: styles.dragging } : {}
  const label = labelOf(itemKey)
  const position: DropPosition = keys.indexOf(dragging) > keys.indexOf(itemKey) ? 'before' : 'after'
  return {
    ...(active && {
      ...dropProps,
      tabIndex: -1,
      'aria-label': self
        ? `Leave ${label} where it is`
        : `${position === 'before' ? 'Before' : 'After'} ${label}`,
    }),
    className: clsx(
      self && styles.dragging,
      isDropTarget && !self && [styles[position], orientation === 'horizontal' && styles.horizontal],
    ),
  }
}
