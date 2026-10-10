import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, PERMISSION_DENIED } from '../api/client'
import type { ScopeGate } from '../auth/scope'
import { gate as settle } from '../test/page'
import { InlineEdit } from './inline-edit'

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
})
