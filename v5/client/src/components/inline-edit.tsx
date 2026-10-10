import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import type { ScopeGate } from '../auth/scope'
import { MISSING } from '../format'
import { ErrorMessage } from './feedback'
import styles from './inline-edit.module.css'

interface Props {
  /** What the field is: the input's accessible name, and part of the Edit button's. */
  label: string
  /** The stored value, or null when the field has none. */
  value: string | null
  /** Whether the change is allowed (see `useScopeGate`), for Edit and Save. */
  gate: ScopeGate
  /** Why `text`, trimmed and not empty, cannot be saved, or undefined if it can. */
  invalid?: (text: string) => string | undefined
  maxLength?: number
  /**
   * Save `text`, trimmed, or clear the value (null) when the input is emptied. The input closes
   * once it resolves, and stays open, saying why, if it rejects.
   */
  onSave(text: string | null): Promise<unknown>
}

/**
 * A field edited in place (AR2 "Inline editing"): its value and an Edit button, which replaces them
 * with an input, Save and Cancel. Enter saves and Escape cancels. The field shows `value` as its
 * owner gives it, so an edit shows once the owner has the value the API returned.
 */
export function InlineEdit({ label, value, gate, invalid, maxLength, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const reasonId = useId()
  const editButton = useRef<HTMLButtonElement>(null)
  // Whether the focus goes back to Edit once the input has closed.
  const refocus = useRef(false)
  useEffect(() => {
    if (!editing && refocus.current) {
      refocus.current = false
      editButton.current?.focus()
    }
  }, [editing])

  const term = text.trim()
  const reason = term === '' ? undefined : invalid?.(term)

  const close = () => {
    refocus.current = true
    setEditing(false)
  }
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (saving || gate.disabled || reason !== undefined) return
    // Nothing to change: no request.
    if (term === (value ?? '')) return close()
    setSaving(true)
    setError(null)
    try {
      await onSave(term === '' ? null : term)
      close()
    } catch (failure) {
      setError(failure)
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <span className={styles.root}>
        <span>{value ?? MISSING}</span>
        <button
          type="button"
          ref={editButton}
          className={styles.button}
          aria-label={`Edit ${label}`}
          {...gate}
          onClick={() => {
            setText(value ?? '')
            setError(null)
            setEditing(true)
          }}
        >
          Edit
        </button>
      </span>
    )
  }

  // While a save is under way, nothing can be used, but nothing is disabled either, which would
  // lose the focus: a save that fails leaves the user where they were.
  const busy = saving || undefined
  return (
    <div className={styles.editor}>
      <form
        className={styles.root}
        aria-label={`Edit ${label}`}
        onSubmit={save}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !saving) close()
        }}
      >
        <input
          type="text"
          aria-label={label}
          value={text}
          onChange={(event) => setText(event.target.value)}
          readOnly={saving}
          maxLength={maxLength}
          aria-invalid={reason !== undefined || undefined}
          aria-describedby={reason === undefined ? undefined : reasonId}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {reason !== undefined && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
        <button
          type="submit"
          className={styles.button}
          disabled={gate.disabled || reason !== undefined}
          aria-disabled={busy}
          title={gate.title ?? reason}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className={styles.button}
          aria-disabled={busy}
          onClick={() => {
            if (!saving) close()
          }}
        >
          Cancel
        </button>
      </form>
      {error !== null && <ErrorMessage error={error} />}
    </div>
  )
}
