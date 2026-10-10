import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, PERMISSION_DENIED } from '../api/client'
import type { ScopeGate } from '../auth/scope'
import { gate as settle } from '../test/page'
import { InlineEdit, type EditorProps } from './inline-edit'

const ALLOWED: ScopeGate = { disabled: false, title: undefined }

interface Options {
  value?: string | null
  gate?: ScopeGate
  invalid?: (text: string) => string | undefined
  /** What saving does; by default, it succeeds, and the value becomes what was saved. */
  save?: (text: string | null) => Promise<unknown>
}

/** An editor of a field labelled `Tag`, whose owner stores what a save succeeds with. */
function renderEditor({ value = 'v1', gate = ALLOWED, invalid, save }: Options = {}) {
  const onSave = vi.fn(save ?? (() => Promise.resolve()))
  function Owner() {
    const [stored, setStored] = useState(value)
    return (
      <InlineEdit
        label="Tag"
        value={stored}
        gate={gate}
        invalid={invalid}
        maxLength={256}
        onSave={async (text) => {
          await onSave(text)
          setStored(text)
        }}
      />
    )
  }
  render(<Owner />)
  return { onSave }
}

const editButton = () => screen.getByRole('button', { name: 'Edit Tag' })
const input = () => screen.getByRole('textbox', { name: 'Tag' })
const saveButton = () => screen.getByRole('button', { name: /^Sav/ })

function edit(text?: string) {
  fireEvent.click(editButton())
  if (text !== undefined) fireEvent.change(input(), { target: { value: text } })
}

describe('InlineEdit', () => {
  it('shows the value, or that there is none, with an Edit button', () => {
    renderEditor({ value: null })

    expect(screen.getByText('--')).toBeInTheDocument()
    expect(editButton()).toHaveTextContent('Edit')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('cannot be edited without the scope, and says why', () => {
    renderEditor({ gate: { disabled: true, title: 'Needs manage.' } })

    expect(editButton()).toBeDisabled()
    expect(editButton()).toHaveAttribute('title', 'Needs manage.')
  })

  it('edits the value in an input that takes the focus, bounded in length', () => {
    renderEditor()

    edit()

    expect(input()).toHaveValue('v1')
    expect(input()).toHaveFocus()
    expect(input()).toHaveAttribute('maxLength', '256')
  })

  it('saves the text, trimmed, with Enter, then shows the value and focuses Edit', async () => {
    const { onSave } = renderEditor()
    edit('  v2 ')

    fireEvent.submit(input())

    expect(await screen.findByText('v2')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledWith('v2')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(editButton()).toHaveFocus()
  })

  it('clears the value when the input is emptied, even of spaces', async () => {
    const { onSave } = renderEditor()
    edit('   ')

    fireEvent.click(saveButton())

    expect(await screen.findByText('--')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledWith(null)
  })

  it('closes without saving when the text is the value', () => {
    const { onSave } = renderEditor()
    edit(' v1')

    fireEvent.submit(input())

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('leaves a value with surrounding spaces as it is, unless its text is edited', async () => {
    const { onSave } = renderEditor({ value: ' v1 ' })

    edit()
    fireEvent.submit(input())
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onSave).not.toHaveBeenCalled()

    edit(' v1')
    fireEvent.submit(input())
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('v1'))
  })

  it('is cancelled with Cancel or Escape, keeping the value, and focuses Edit', () => {
    const { onSave } = renderEditor()

    edit('v2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(editButton()).toHaveFocus()

    edit('v2')
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(editButton()).toHaveFocus()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('starts from the value again after a cancelled edit', () => {
    renderEditor()
    edit('v2')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    edit()

    expect(input()).toHaveValue('v1')
  })

  it('cannot be used while a save is under way, but keeps the focus', async () => {
    const pending = settle()
    const { onSave } = renderEditor({ save: () => pending.promise })
    edit('v2')

    fireEvent.submit(input())

    expect(saveButton()).toHaveTextContent('Saving...')
    expect(saveButton()).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveAttribute('aria-disabled', 'true')
    expect(input()).toHaveAttribute('readOnly')
    expect(input()).toHaveFocus()
    fireEvent.submit(input())
    fireEvent.keyDown(input(), { key: 'Escape' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(input()).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(1)

    await act(async () => pending.open())
    expect(screen.getByText('v2')).toBeInTheDocument()
  })

  it('stays open with its text when a save fails, saying why, and can be tried again', async () => {
    let fail = true
    const { onSave } = renderEditor({
      save: () => (fail ? Promise.reject(new ApiError(403, 'forbidden', 'No')) : Promise.resolve()),
    })
    edit('v2')

    fireEvent.submit(input())

    expect(await screen.findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
    expect(input()).toHaveValue('v2')
    expect(input()).toHaveFocus()
    expect(saveButton()).not.toHaveAttribute('aria-disabled')
    fail = false
    fireEvent.submit(input())
    expect(await screen.findByText('v2')).toBeInTheDocument()
    expect(onSave).toHaveBeenCalledTimes(2)
  })

  it('shows invalid text with a halo, and does not save it', () => {
    const { onSave } = renderEditor({
      invalid: (text) => (/^\d+$/.test(text) ? undefined : 'A whole number, please.'),
    })

    edit('12a')
    expect(input()).toHaveAttribute('aria-invalid', 'true')
    expect(input()).toHaveAccessibleDescription('A whole number, please.')
    expect(saveButton()).toBeDisabled()
    expect(saveButton()).toHaveAttribute('title', 'A whole number, please.')
    fireEvent.submit(input())
    expect(onSave).not.toHaveBeenCalled()

    // Validated as it would be saved: trimmed, and empty to clear.
    for (const text of [' 12 ', '']) {
      fireEvent.change(input(), { target: { value: text } })
      expect(input()).not.toHaveAttribute('aria-invalid')
      expect(saveButton()).toBeEnabled()
    }
  })

  it('cannot save once the scope is lost', () => {
    const gate = { disabled: true, title: 'Needs manage.' }
    function Owner() {
      const [allowed, setAllowed] = useState(true)
      return (
        <>
          <button onClick={() => setAllowed(false)}>Lose scope</button>
          <InlineEdit
            label="Tag"
            value="v1"
            gate={allowed ? ALLOWED : gate}
            onSave={() => Promise.resolve()}
          />
        </>
      )
    }
    render(<Owner />)
    edit('v2')

    fireEvent.click(screen.getByRole('button', { name: 'Lose scope' }))

    expect(saveButton()).toBeDisabled()
    expect(saveButton()).toHaveAttribute('title', 'Needs manage.')
  })

  it('shows the value as `display` gives it, and a missing one as such', () => {
    function Owner() {
      const [value, setValue] = useState<string | null>('v1')
      return (
        <>
          <button onClick={() => setValue(null)}>Unset</button>
          <InlineEdit
            label="Tag"
            value={value}
            display={(shown) => <a href={`/${shown}`}>the {shown} link</a>}
            gate={ALLOWED}
            onSave={() => Promise.resolve()}
          />
        </>
      )
    }
    render(<Owner />)

    expect(screen.getByRole('link', { name: 'the v1 link' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Unset' }))
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(screen.getByText('--')).toBeInTheDocument()
  })

  describe('multiline', () => {
    function renderNotes(save = vi.fn(() => Promise.resolve())) {
      render(<InlineEdit label="Notes" value={'a\nb'} gate={ALLOWED} multiline onSave={save} />)
      fireEvent.click(screen.getByRole('button', { name: 'Edit Notes' }))
      return { save, area: screen.getByRole('textbox', { name: 'Notes' }) }
    }

    it('edits in a text area that takes the focus, where Enter starts a new line', () => {
      const { save, area } = renderNotes()

      expect(area.tagName).toBe('TEXTAREA')
      expect(area).toHaveValue('a\nb')
      expect(area).toHaveFocus()
      fireEvent.change(area, { target: { value: 'a\nb\n' } })
      fireEvent.keyDown(area, { key: 'Enter' })
      expect(save).not.toHaveBeenCalled()
    })

    it.each([['ctrlKey'], ['metaKey']])('saves with Enter and %s', async (modifier) => {
      const { save, area } = renderNotes()
      fireEvent.change(area, { target: { value: ' a\nc ' } })

      fireEvent.keyDown(area, { key: 'Enter', [modifier]: true })

      await waitFor(() => expect(save).toHaveBeenCalledWith('a\nc'))
    })

    it('is cancelled with Escape', () => {
      const { save, area } = renderNotes()

      fireEvent.keyDown(area, { key: 'Escape' })

      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(save).not.toHaveBeenCalled()
    })
  })

  describe('with an editor of its own', () => {
    /**
     * A field edited by an editor of its own: an input whose text is only `text` once committed
     * with a click on Commit, which keeps Escape to itself while its "list" is open.
     */
    function CustomEditor({ label, text, setText, setPending, saving }: EditorProps) {
      const [typed, setTyped] = useState(text)
      const [open, setOpen] = useState(false)
      return (
        <>
          <input
            aria-label={label}
            aria-expanded={open}
            value={typed}
            readOnly={saving}
            onChange={(event) => {
              setTyped(event.target.value)
              setPending(event.target.value !== text)
              setOpen(true)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false)
                event.stopPropagation()
              }
            }}
          />
          <button
            type="button"
            onClick={() => {
              setText(typed)
              setPending(false)
            }}
          >
            Commit
          </button>
        </>
      )
    }

    function renderCustom(
      save: (text: string | null) => Promise<unknown> = () => Promise.resolve(),
    ) {
      const onSave = vi.fn(save)
      render(
        <InlineEdit
          label="Commit"
          value="abc"
          gate={ALLOWED}
          editor={(props) => <CustomEditor {...props} />}
          pendingReason="Pick one first."
          onSave={onSave}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: 'Edit Commit' }))
      return { onSave, field: screen.getByRole('textbox', { name: 'Commit' }) }
    }

    it('focuses the editor, and saves the text it sets', async () => {
      const { onSave, field } = renderCustom()

      expect(field).toHaveFocus()
      fireEvent.change(field, { target: { value: 'def' } })
      fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
      fireEvent.submit(field)

      await waitFor(() => expect(onSave).toHaveBeenCalledWith('def'))
    })

    it('refuses to save while the editor reports pending input, saying why', () => {
      const { onSave, field } = renderCustom()

      fireEvent.change(field, { target: { value: 'def' } })
      const save = screen.getByRole('button', { name: 'Save' })
      expect(save).toHaveAttribute('aria-disabled', 'true')
      expect(save).toHaveAccessibleDescription('Pick one first.')
      fireEvent.submit(field)
      expect(onSave).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
      expect(save).not.toHaveAttribute('aria-disabled')
      expect(screen.queryByText('Pick one first.')).not.toBeInTheDocument()
    })

    it('leaves an Escape to an editor whose list is open, and cancels on the next', () => {
      const { field } = renderCustom()

      fireEvent.change(field, { target: { value: 'def' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(field).toHaveAttribute('aria-expanded', 'false')
      expect(field).toBeInTheDocument()

      // Cancelled, although the editor keeps the Escape from reaching the form.
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Edit Commit' })).toHaveFocus()
    })

    it('tells the editor while a save is under way', async () => {
      const pending = settle()
      const { field } = renderCustom(() => pending.promise)

      fireEvent.change(field, { target: { value: 'def' } })
      fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
      fireEvent.submit(field)

      expect(field).toHaveAttribute('readOnly')
      await act(async () => pending.open())
      expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    })

    it('starts afresh, with nothing pending, each time it opens', () => {
      const { field } = renderCustom()
      fireEvent.change(field, { target: { value: 'def' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      fireEvent.click(screen.getByRole('button', { name: 'Edit Commit' }))

      expect(screen.getByRole('textbox', { name: 'Commit' })).toHaveValue('abc')
      expect(screen.getByRole('button', { name: 'Save' })).not.toHaveAttribute('aria-disabled')
    })
  })
})
