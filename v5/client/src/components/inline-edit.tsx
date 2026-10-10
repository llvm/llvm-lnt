import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import type { ScopeGate } from '../auth/scope'
import { MISSING } from '../format'
import { ErrorMessage } from './feedback'
import { pendingGuard } from './pending-guard'
import styles from './inline-edit.module.css'

/** What a custom editor (see `editor`) is given. */
export interface EditorProps {
  /** The input's accessible name. */
  label: string
  /** The text to save: the value's own when the editor opens. */
  text: string
  setText(text: string): void
  /**
   * Report whether the editor holds input that `text` does not reflect yet, such as text typed in
   * a combobox but not picked: Save is refused meanwhile, saying `pendingReason`.
   */
  setPending(pending: boolean): void
  /** A save is under way: the editor must not change, but must keep the focus. */
  saving: boolean
}

interface Props {
  /** What the field is: the input's accessible name, and part of the Edit button's. */
  label: string
  /** The stored value, or null when the field has none. */
  value: string | null
  /** How a value that is not null is shown, if not as its text. */
  display?: (value: string) => ReactNode
  /** Whether the change is allowed (see `useScopeGate`), for Edit and Save. */
  gate: ScopeGate
  /** Why `text`, trimmed and not empty, cannot be saved, or undefined if it can. */
  invalid?: (text: string) => string | undefined
  maxLength?: number
  /**
   * Edit in a text area, where Enter starts a new line and Ctrl+Enter (Cmd+Enter on a Mac)
   * saves.
   */
  multiline?: boolean
  /** An input of its own in place of the text input, such as a commit picker. */
  editor?: (props: EditorProps) => ReactNode
  /** Why Save is refused while the editor reports pending input (see `EditorProps`). */
  pendingReason?: string
  /**
   * Save `text`, trimmed, or clear the value (null) when the input is emptied. The input closes
   * once it resolves, and stays open, saying why, if it rejects.
   */
  onSave(text: string | null): Promise<unknown>
}

/**
 * A field edited in place (AR2 "Inline editing"): its value and an Edit button, which replaces them
 * with an input, Save and Cancel. Enter saves and Escape cancels, unless the input uses the key
 * itself. The field shows `value` as its owner gives it, so an edit shows once the owner has the
 * value the API returned.
 */
export function InlineEdit({
  label,
  value,
  display,
  gate,
  invalid,
  maxLength,
  multiline = false,
  editor,
  pendingReason,
  onSave,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const reasonId = useId()
  const editButton = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLFormElement>(null)
  // Whether the focus goes to the input, or back to Edit, once the editor has opened or closed.
  const refocus = useRef(false)
  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (editing) form.current?.querySelector<HTMLElement>('input, textarea')?.focus()
    else editButton.current?.focus()
  }, [editing])

  const term = text.trim()
  const reason = term === '' ? undefined : invalid?.(term)

  const open = () => {
    setText(value ?? '')
    setPending(false)
    setError(null)
    refocus.current = true
    setEditing(true)
  }
  const close = () => {
    refocus.current = true
    setEditing(false)
  }
  const save = async (event: { preventDefault(): void }) => {
    event.preventDefault()
    if (saving || pending || gate.disabled || reason !== undefined) return
    // Nothing to change -- the text the input opened with, or the value itself -- so no request,
    // which for a value stored with surrounding spaces would replace it with its trimmed form.
    if (text === (value ?? '') || term === (value ?? '')) return close()
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

  // Before the input sees it, so that an editor's own handling of Escape cannot keep it from
  // cancelling -- except while the editor has a popup expanded, such as a combobox's list, which
  // the Escape closes instead.
  const onKeyDownCapture = (event: KeyboardEvent) => {
    // An Escape ending an input method's composition belongs to it.
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    if ((event.target as Element).getAttribute('aria-expanded') === 'true') return
    if (!saving) close()
  }

  if (!editing) {
    return (
      <span className={styles.root}>
        <span>{value === null ? MISSING : (display?.(value) ?? value)}</span>
        <button
          type="button"
          ref={editButton}
          className={styles.button}
          aria-label={`Edit ${label}`}
          {...gate}
          onClick={open}
        >
          Edit
        </button>
      </span>
    )
  }

  // While a save is under way, nothing can be used, but nothing is disabled either, which would
  // lose the focus: a save that fails leaves the user where they were.
  const busy = saving || undefined
  const inputProps = {
    'aria-label': label,
    value: text,
    readOnly: saving,
    maxLength,
    'aria-invalid': reason !== undefined || undefined,
    'aria-describedby': reason === undefined ? undefined : reasonId,
    autoComplete: 'off',
    spellCheck: false,
  }
  let input
  if (editor) {
    input = editor({ label, text, setText, setPending, saving })
  } else if (multiline) {
    input = (
      <textarea
        {...inputProps}
        className={styles.textarea}
        rows={5}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
          if (event.ctrlKey || event.metaKey) void save(event)
        }}
      />
    )
  } else {
    input = <input type="text" {...inputProps} onChange={(event) => setText(event.target.value)} />
  }

  const pendingId = `${reasonId}-pending`
  return (
    <div className={styles.editor}>
      <form
        ref={form}
        className={styles.root}
        aria-label={`Edit ${label}`}
        onSubmit={save}
        onKeyDownCapture={onKeyDownCapture}
      >
        {input}
        {reason !== undefined && <VisuallyHidden id={reasonId}>{reason}</VisuallyHidden>}
        <button
          type="submit"
          className={styles.button}
          disabled={gate.disabled || reason !== undefined}
          aria-disabled={busy}
          title={gate.title ?? reason}
          aria-describedby={pending && pendingReason !== undefined ? pendingId : undefined}
          {...pendingGuard(pending)}
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
        {pending && pendingReason !== undefined && (
          <span id={pendingId} className={styles.reason}>
            {pendingReason}
          </span>
        )}
      </form>
      {error !== null && <ErrorMessage error={error} />}
    </div>
  )
}
