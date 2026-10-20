import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { VisuallyHidden } from 'react-aria-components'
import type { ScopeGate } from '../auth/scope'
import { MISSING } from '../format'
import { Confirmation } from './confirmation'
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
  /**
   * A save is under way, or waits for its confirmation: the editor must not change, but must keep
   * the focus.
   */
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
  /**
   * Why empty text cannot be saved, for a field that must have a value. Without it, emptying the
   * input clears the value.
   */
  required?: string
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
  /** The id of what describes the field, such as its help, for the Edit button and the input. */
  describedBy?: string
  /**
   * What to ask before saving `text`, trimmed, for a change with consequences the user must
   * acknowledge: Save shows it with OK and Cancel, and only OK saves.
   */
  confirm?: (text: string) => ReactNode
  /**
   * Save `text`, trimmed, or clear the value (null) when the input is emptied, which `required`
   * prevents. The input closes once it resolves, and stays open, saying why, if it rejects.
   */
  onSave(text: string | null): Promise<unknown>
}

/**
 * A field edited in place (AR12): its value and an Edit button, which replaces them with an input,
 * Save and Cancel. Enter saves and Escape cancels, unless the input uses the key itself. The field
 * shows `value` as its owner gives it, so an edit shows once the owner has the value the API
 * returned.
 */
export function InlineEdit({
  label,
  value,
  display,
  gate,
  invalid,
  required,
  maxLength,
  multiline = false,
  editor,
  pendingReason,
  describedBy,
  confirm,
  onSave,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirming, setConfirming] = useState(false)
  // Nothing can be used while a save is under way or waits for its confirmation, but nothing is
  // disabled either, which would lose the focus: a save that fails leaves the user where they were.
  const busy = saving || confirming
  const [error, setError] = useState<unknown>(null)
  const reasonId = useId()
  const gateId = useId()
  const editButton = useRef<HTMLButtonElement>(null)
  const form = useRef<HTMLFormElement>(null)
  // Whether the focus goes to the input, or back to Edit, once the editor has opened or closed.
  const refocus = useRef(false)
  const focusInput = () => form.current?.querySelector<HTMLElement>('input, textarea')?.focus()
  // In the commit, before the page is painted, so that the value never shows without the focus on
  // Edit after a save.
  useLayoutEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (editing) focusInput()
    else editButton.current?.focus()
  }, [editing])

  const term = text.trim()
  const reason = term === '' ? required : invalid?.(term)

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
    if (busy || pending || gate.disabled || reason !== undefined) return
    // Nothing to change -- the text the input opened with, or the value itself -- so no request,
    // which for a value stored with surrounding spaces would replace it with its trimmed form.
    if (text === (value ?? '') || term === (value ?? '')) return close()
    if (confirm) setConfirming(true)
    else await commit()
  }
  // Back to the input, which the prompt's buttons had the focus from.
  const closePrompt = () => {
    setConfirming(false)
    focusInput()
  }
  const commit = async () => {
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
  // the Escape closes instead. While the confirmation is asked, it cancels the confirmation.
  const onKeyDownCapture = (event: KeyboardEvent) => {
    // An Escape ending an input method's composition belongs to it.
    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
    if ((event.target as Element).getAttribute('aria-expanded') === 'true') return
    if (confirming) closePrompt()
    else if (!saving) close()
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
          // A description replaces the title assistive technology would otherwise read, so the
          // reason the gate gives joins it.
          aria-describedby={
            [describedBy, gate.title && describedBy ? gateId : undefined]
              .filter(Boolean)
              .join(' ') || undefined
          }
          {...gate}
          onClick={open}
        >
          Edit
        </button>
        {gate.title && describedBy && <VisuallyHidden id={gateId}>{gate.title}</VisuallyHidden>}
      </span>
    )
  }

  const inputProps = {
    'aria-label': label,
    value: text,
    readOnly: busy,
    maxLength,
    'aria-invalid': reason !== undefined || undefined,
    'aria-describedby':
      [describedBy, reason === undefined ? undefined : reasonId].filter(Boolean).join(' ') ||
      undefined,
    autoComplete: 'off',
    spellCheck: false,
  }
  let input
  if (editor) {
    input = editor({ label, text, setText, setPending, saving: busy })
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
          aria-disabled={busy || undefined}
          title={gate.title ?? reason}
          aria-describedby={pending && pendingReason !== undefined ? pendingId : undefined}
          {...pendingGuard(pending)}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          type="button"
          className={styles.button}
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) close()
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
      {confirming && confirm && (
        // The focus starts on its Cancel, and goes back to the input once it closes.
        <Confirmation
          confirmLabel="OK"
          gate={gate}
          onConfirm={async () => {
            closePrompt()
            await commit()
          }}
          onCancel={closePrompt}
        >
          {confirm(term)}
        </Confirmation>
      )}
      {error !== null && <ErrorMessage error={error} />}
    </div>
  )
}
