import { useCallback, useState, type RefObject } from 'react'
import { focusLost } from './use-focus-once-checked'

/**
 * The confirmation of an action on one row of a table, such as deleting what it shows: which row's
 * is being confirmed, if any, and where the focus goes once the prompt closes.
 *
 * `open` starts confirming the row's, from the button that asked for it, which `cancel` returns the
 * focus to. Once the action has succeeded, `done` closes the prompt and gives the focus to
 * `tableRef`'s table, since the button that had it may be gone with the row. `close` closes it
 * when the row has gone otherwise, deleted elsewhere say, and gives the table the focus if it went
 * down with the prompt, unless `refocus` is false, when something else is to take it. `open`, `done` and `close` keep their identity, so that columns built
 * with them need not be built again.
 */
export function useRowConfirm<Item>(tableRef: RefObject<HTMLTableElement | null>) {
  const [target, setTarget] = useState<{ item: Item; opener: HTMLElement } | null>(null)
  const open = useCallback((item: Item, opener: HTMLElement) => setTarget({ item, opener }), [])
  const done = useCallback(() => {
    setTarget(null)
    tableRef.current?.focus()
  }, [tableRef])
  const close = useCallback(
    (refocus = true) => {
      setTarget(null)
      if (refocus && focusLost()) tableRef.current?.focus()
    },
    [tableRef],
  )
  return {
    item: target?.item ?? null,
    open,
    close,
    cancel: () => {
      target?.opener.focus()
      setTarget(null)
    },
    done,
  }
}
