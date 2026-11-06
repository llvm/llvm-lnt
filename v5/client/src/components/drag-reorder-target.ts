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

export interface ReorderState {
  /** The drag type of the list's items, which no other list's accept. */
  type: string
  keys: readonly string[]
  labelOf(key: string): string
  /** The item being dragged, if any. */
  dragging: string | null
  setDragging(key: string | null): void
  preview: RefObject<DragPreviewRenderer | null>
  onMove(key: string, target: string): void
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
 * of the item being dragged.
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
  const { type, keys, labelOf, dragging, onMove } = useReorderState()
  // A drop target only while an item is dragged. From the keyboard, react-aria goes through the
  // drop targets in the order they registered, not in the order they are shown in: registering
  // them all as a drag starts, as they render, makes the two the same, whatever moved before.
  // react-aria starts from the target holding the grip, if any, and from the nearest one on screen
  // otherwise, which would make the order depend on the layout: so the item dragged is a target
  // too, which leaves it where it is.
  const active = dragging !== null && !isDisabled
  const self = dragging === itemKey
  const position: DropPosition =
    keys.indexOf(dragging ?? '') > keys.indexOf(itemKey) ? 'before' : 'after'
  const { dropProps, isDropTarget } = useDrop({
    ref: element,
    isDisabled: !active,
    getDropOperation: (types) => (types.has(type) ? 'move' : 'cancel'),
    onDrop: () => {
      if (dragging !== null && !self) onMove(dragging, itemKey)
    },
  })
  if (dragging === null) return {}
  const label = labelOf(itemKey)
  return {
    ...(active && {
      ...dropProps,
      tabIndex: -1,
      'aria-label': self
        ? `Leave ${label} where it is`
        : `${position === 'before' ? 'Before' : 'After'} ${label}`,
    }),
    className: clsx(self && styles.dragging, isDropTarget && !self && styles[position]),
  }
}
