import { useState, type RefObject } from 'react'

/**
 * The confirmation of an action on one row of a table, such as deleting what it shows: which row's
 * is being confirmed, if any, and where the focus goes once the prompt closes.
 *
 * `open` starts confirming the row's, from the button that asked for it, which `cancel` returns the
 * focus to. Once the action has succeeded, `done` closes the prompt and gives the focus to
 * `tableRef`'s table, since the button that had it may be gone with the row.
 */
export function useRowConfirm<Item>(tableRef: RefObject<HTMLTableElement | null>) {
  const [target, setTarget] = useState<{ item: Item; opener: HTMLElement } | null>(null)
  return {
    item: target?.item ?? null,
    open: (item: Item, opener: HTMLElement) => setTarget({ item, opener }),
    cancel: () => {
      target?.opener.focus()
      setTarget(null)
    },
    done: () => {
      setTarget(null)
      tableRef.current?.focus()
    },
  }
}
