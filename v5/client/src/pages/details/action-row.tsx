import { useEffect, useRef, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { forgetSuite, forgetUnobserved } from '../../api/keys'
import { ActionRow, type Deletion as RowDeletion } from '../../components/action-row'

/** The deletion of the entity a detail page is about. */
interface Deletion extends Omit<RowDeletion, 'onDeleted'> {
  /** The suite the entity belongs to, whose data the deletion changes. */
  suite: string
  /** Where to go once it is deleted, since the page shows nothing any more. */
  leaveTo: string
}

interface Props {
  /** The actions before the Delete button, if any. */
  children?: ReactNode
  deletion: Deletion
}

/**
 * The row of actions below a detail page's info box, ending with the button deleting the entity,
 * and the prompt confirming the deletion below the row (AR2 "Deletions"). Once deleted, the page
 * leaves for `leaveTo`, in place of itself in the history, unless the user has left it already.
 */
export function DetailActionRow({ children, deletion }: Props) {
  const { suite, leaveTo, ...rest } = deletion
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // Whether the page has left the entity it deleted.
  const left = useRef(false)
  useEffect(
    () => () => {
      // What the page read is kept by `forgetSuite` while the page shows it, and would otherwise be
      // shown again if the history leads back to it (AR2 "Deletions"). It is dropped once the page
      // has unmounted rather than once it navigates, since the page can stay mounted, hidden, while
      // the next page's code loads. React cleans up a page's components parent first, so its other
      // parts still observe their queries now, but no longer once the cleanup has run through it.
      if (left.current) queueMicrotask(() => forgetUnobserved(queryClient, suite))
    },
    [queryClient, suite],
  )
  const onDeleted = async (leaving: boolean) => {
    await forgetSuite(queryClient, suite, { leaving })
    if (leaving) {
      left.current = true
      navigate(leaveTo, { replace: true })
    }
  }
  return <ActionRow deletion={{ ...rest, onDeleted }}>{children}</ActionRow>
}
