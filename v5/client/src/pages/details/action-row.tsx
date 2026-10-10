import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { forgetSuite } from '../../api/keys'
import { useScopeGate, type Scope } from '../../auth/scope'
import { ConfirmDelete } from '../../components/confirm-delete'
import { DangerButton } from '../../components/danger-button'
import styles from './details.module.css'

/** The deletion of the entity a detail page is about. */
interface Deletion {
  /** The suite the entity belongs to, whose data the deletion changes. */
  suite: string
  /** The Delete button's label, e.g. `Delete Machine`. */
  label: string
  /** The scope deleting needs. */
  scope: Scope
  /** What to type to confirm (AR2 "Deletions"). */
  expected: string
  /** What the deletion destroys. */
  message: ReactNode
  /** Shown while the deletion runs, for one that may take a while. */
  busyMessage?: string
  /** Delete the entity. */
  onDelete(): Promise<unknown>
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
export function ActionRow({ children, deletion }: Props) {
  const { suite, label, scope, expected, message, busyMessage, onDelete, leaveTo } = deletion
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const gate = useScopeGate(scope)
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  // Whether the page is still shown once the deletion is done.
  const shown = useRef(false)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])

  const remove = async () => {
    await onDelete()
    const leaving = shown.current
    await forgetSuite(queryClient, suite, { leaving })
    if (leaving) navigate(leaveTo, { replace: true })
  }

  return (
    <>
      <div className={styles.actions}>
        {children}
        <DangerButton
          type="button"
          ref={deleteButton}
          {...gate}
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          {label}
        </DangerButton>
      </div>
      {confirming && (
        <ConfirmDelete
          expected={expected}
          scope={scope}
          busyMessage={busyMessage}
          onConfirm={remove}
          onCancel={() => {
            setConfirming(false)
            deleteButton.current?.focus()
          }}
        >
          {message}
        </ConfirmDelete>
      )}
    </>
  )
}
