import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ApiError } from '../api/client'
import { useScopeGate, type Scope } from '../auth/scope'
import { ConfirmDelete } from './confirm-delete'
import { DangerButton } from './danger-button'
import styles from './action-row.module.css'

/** The deletion of what a page, or a part of one, is about. */
export interface Deletion {
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
  /**
   * Delete it. A rejection is shown in the prompt, which stays open to try again, except a
   * `not_found`: what was already deleted, from elsewhere, counts as deleted (AR2 "Deletions").
   */
  onDelete(): Promise<unknown>
  /**
   * Forget it once it is deleted: `shown` says whether the row is still shown, rather than left by
   * the user meanwhile.
   */
  onDeleted(shown: boolean): Promise<unknown> | void
}

interface Props {
  /** The actions before the Delete button, if any. */
  children?: ReactNode
  deletion: Deletion
  /** Set the Delete button apart, at the far end of the row. */
  deleteAtEnd?: boolean
}

/**
 * A row of actions ending with the button deleting what the page shows, and the prompt confirming
 * the deletion below the row (AR2 "Deletions"). Cancelling gives the focus back to the button.
 */
export function ActionRow({ children, deletion, deleteAtEnd = false }: Props) {
  const { label, scope, expected, message, busyMessage, onDelete, onDeleted } = deletion
  const gate = useScopeGate(scope)
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)
  // Whether the row is still shown once the deletion is done.
  const shown = useRef(false)
  useEffect(() => {
    shown.current = true
    return () => {
      shown.current = false
    }
  }, [])

  const remove = async () => {
    try {
      await onDelete()
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'not_found')) throw error
    }
    await onDeleted(shown.current)
  }

  return (
    <>
      <div className={styles.actions}>
        {children}
        <DangerButton
          type="button"
          ref={deleteButton}
          className={clsx(deleteAtEnd && styles.end)}
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
