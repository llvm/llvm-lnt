import { useId, useState, type FormEvent, type ReactNode } from 'react'
import { useScopeGate, type Scope } from '../auth/scope'
import { DangerButton } from './danger-button'
import { ErrorMessage } from './feedback'
import styles from './confirm-delete.module.css'

interface Props {
  /** What is about to happen, and what it destroys. */
  children: ReactNode
  /**
   * The text to type to confirm (AR2 "Deletions"): a name, a commit string, or the first 8
   * characters of a UUID. Without one, the confirmation is a plain one, for an action that destroys
   * nothing, such as revoking an API key.
   */
  expected?: string
  /** The confirming button's label. */
  confirmLabel?: string
  /** Shown while `onConfirm` runs, for an action that may take a while. */
  busyMessage?: string
  /**
   * The scope the action needs, without which the confirming button is disabled, as AR2 gates it:
   * the token may change, or be checked again, while the prompt is open.
   */
  scope: Scope
  /** Do it. A rejection is shown in the prompt, which stays open to try again. */
  onConfirm(): Promise<unknown>
  onCancel(): void
}

/**
 * The confirmation of a destructive action, by typing `expected` before it is sent (AR2
 * "Deletions"): the prompt says what to type, and its button is enabled once it is typed exactly.
 * Without `expected`, it is a plain confirmation. Escape cancels. Its owner closes it once
 * `onConfirm` succeeds, navigating away, say.
 */
export function ConfirmDelete({
  children,
  expected,
  confirmLabel = 'Delete',
  busyMessage,
  scope,
  onConfirm,
  onCancel,
}: Props) {
  const promptId = useId()
  const messageId = useId()
  const gate = useScopeGate(scope)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const confirmed = expected === undefined || typed === expected

  const confirm = async (event: FormEvent) => {
    event.preventDefault()
    if (!confirmed || busy || gate.disabled) return
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
    <form
      className={styles.root}
      aria-label="Confirmation"
      // What is being confirmed, which the focus, on a control of the prompt, would not say.
      aria-describedby={messageId}
      onSubmit={confirm}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onCancel()
      }}
    >
      <div id={messageId} className={styles.message}>
        {children}
      </div>
      {expected !== undefined && (
        // Not a <label>: a click on one, which selecting its text ends with, focuses the input, and
        // Safari then drops the selection, so that the text could not be copied.
        <p id={promptId} className={styles.prompt}>
          Type <code>{expected}</code> to confirm:
        </p>
      )}
      <div className={styles.row}>
        {expected !== undefined && (
          <input
            aria-labelledby={promptId}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        )}
        <DangerButton
          type="submit"
          disabled={!confirmed || busy || gate.disabled}
          title={gate.title}
        >
          {busy ? 'Working...' : confirmLabel}
        </DangerButton>
        {/* Without anything to type, the focus starts on the action that changes nothing, so that
            a stray Enter does not confirm (as the WAI-ARIA alert dialog pattern advises). */}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          autoFocus={expected === undefined}
        >
          Cancel
        </button>
      </div>
      {busy && busyMessage && <p className={styles.hint}>{busyMessage}</p>}
      {error !== null && <ErrorMessage error={error} />}
    </form>
  )
}
