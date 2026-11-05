import { useCallback, useMemo } from 'react'
import { useMutation, useMutationState } from '@tanstack/react-query'
import { arrangeBy, moveTo } from '../order'

/** What the item `key` was moved to, and the order of the list, being saved. */
interface Move {
  key: string
  order: string[]
}

/**
 * Save the new order of a list, `items` in their stored order, each known by `keyOf`, with `save` on
 * each drop (AR24). The list shows the new order straight away, the item that moved faded, and no
 * item can be dragged until `save` resolves, once it has put the order in `items`. If it fails, the
 * list shows `items` as they are again. Returns the props of the list's `Reorderable` but `labelOf`,
 * the items in the order to show them in, the failure of the last save, and what clears it.
 *
 * `mutationKey` names the list's saves, so that a list shown again while one is in progress, as
 * after leaving its page and coming back, shows it too, rather than starting another.
 */
export function useSavedOrder<T>(
  mutationKey: readonly unknown[],
  items: readonly T[],
  keyOf: (item: T) => string,
  save: (order: string[]) => Promise<void>,
) {
  const { mutate, error, reset } = useMutation({
    mutationKey,
    mutationFn: ({ order }: Move) => save(order),
  })
  const pending = useMutationState({
    filters: { mutationKey, exact: true, status: 'pending' },
    select: (mutation) => mutation.state.variables as Move,
  }).at(0)
  const busy = pending !== undefined
  const shown = useMemo(
    () => (pending === undefined ? [...items] : arrangeBy(items, pending.order, keyOf).items),
    [items, pending, keyOf],
  )
  const keys = useMemo(() => shown.map(keyOf), [shown, keyOf])
  const onMove = useCallback(
    (key: string, target: string) => {
      if (!busy) mutate({ key, order: moveTo(keys, key, target) })
    },
    [busy, mutate, keys],
  )
  return {
    list: { keys, onMove, busy, saving: pending?.key ?? null },
    items: shown,
    error,
    // Only once failed: resetting the mutation while it runs would forget it.
    clearError: () => {
      if (error !== null) reset()
    },
  }
}
