import { useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { SuiteRef } from '../api/suites'
import { useScopeGate, type Scope } from '../auth/scope'
import { Confirmation } from './confirmation'
import { DangerButton } from './danger-button'
import styles from './action-row.module.css'

/** The deletion of what a page, or a part of one, is about. */
export interface Deletion {
  /** The Delete button's label, e.g. `Delete Machine`. */
  label: string
  /** The scope deleting needs. */
  scope: Scope
  /** The suite the deletion addresses, which the scope is needed in. */
  suite: SuiteRef
  /** What to type to confirm (AR16). */
  expected: string
  /** What the deletion destroys. */
  message: ReactNode
  /** Shown while the deletion runs, for one that may take a while. */
  busyMessage?: string
  /** Delete it. A rejection is shown in the prompt, which stays open to try again. */
  onDelete(): Promise<unknown>
  /**
   * Forget it once it is deleted, and leave the page if the user is still on it. Called even if the
   * row is no longer shown: whether the user has left the page is up to the page.
   */
  onDeleted(): Promise<unknown> | void
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
 * the deletion below the row (AR16). Cancelling gives the focus back to the button.
 */
export function ActionRow({ children, deletion, deleteAtEnd = false }: Props) {
  const { label, scope, suite, expected, message, busyMessage, onDelete, onDeleted } = deletion
  const gate = useScopeGate(scope, suite)
  const [confirming, setConfirming] = useState(false)
  const deleteButton = useRef<HTMLButtonElement>(null)

  const remove = async () => {
    await onDelete()
    await onDeleted()
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
        <Confirmation
          expected={expected}
          gate={gate}
          busyMessage={busyMessage}
          onConfirm={remove}
          onCancel={() => {
            setConfirming(false)
            deleteButton.current?.focus()
          }}
        >
          {message}
        </Confirmation>
      )}
    </>
  )
}
