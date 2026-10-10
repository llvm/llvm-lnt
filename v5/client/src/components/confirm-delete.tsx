import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { DangerButton } from './danger-button'
import { ErrorMessage } from './feedback'
import styles from './confirm-delete.module.css'

interface Props {
  /** What is about to happen, and what it destroys. */
  children: ReactNode
  /**
   * The text to type to confirm (AR2 "Deletions"): a name, a commit string, or the first 8
   * characters of a UUID.
   */
  expected: string
  /** The confirming button's label. */
  confirmLabel?: string
  /** Shown while `onConfirm` runs, for an action that may take a while. */
  busyMessage?: string
  /** Do it. A rejection is shown in the prompt, which stays open to try again. */
  onConfirm(): Promise<unknown>
  onCancel(): void
}

/**
 * The confirmation of a destructive action, by typing `expected` before it is sent (AR2
 * "Deletions"). The prompt says what to type, and its button is enabled once it is typed exactly.
 * Its owner closes it once `onConfirm` succeeds, navigating away, say.
 */
export function ConfirmDelete({
  children,
  expected,
  confirmLabel = 'Delete',
  busyMessage,
  onConfirm,
  onCancel,
}: Props) {
  const promptId = useId()
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (typed !== expected || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
    } catch (failure) {
      setError(failure)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className={styles.root} aria-label="Confirmation" onSubmit={confirm}>
      <div className={styles.message}>{children}</div>
      {/* Not a <label>: a click on one, which selecting its text ends with, focuses the input, and
          Safari then drops the selection, so that the text could not be copied. */}
      <p id={promptId} className={styles.prompt}>
        Type <code>{expected}</code> to confirm:
      </p>
      <div className={styles.row}>
        <input
          aria-labelledby={promptId}
          type="text"
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !busy) onCancel()
          }}
        />
        <DangerButton type="submit" disabled={typed !== expected || busy}>
          {busy ? 'Working...' : confirmLabel}
        </DangerButton>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {busy && busyMessage && <p className={styles.hint}>{busyMessage}</p>}
      {error !== null && <ErrorMessage error={error} />}
    </form>
  )
}
