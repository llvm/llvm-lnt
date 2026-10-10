import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, PERMISSION_DENIED } from '../api/client'
import { providers } from '../test/render'
import { ConfirmDelete } from './confirm-delete'

function renderPrompt(onConfirm: () => Promise<unknown> = () => Promise.resolve()) {
  const onCancel = vi.fn()
  const confirm = vi.fn(onConfirm)
  render(
    <ConfirmDelete
      expected="573af861"
      scope="read"
      onConfirm={confirm}
      onCancel={onCancel}
      busyMessage="Hold on."
    >
      <p>Delete the run?</p>
    </ConfirmDelete>,
    providers(),
  )
  return {
    input: screen.getByLabelText(/to confirm/),
    button: screen.getByRole('button', { name: 'Delete' }),
    onConfirm: confirm,
    onCancel,
  }
}

describe('ConfirmDelete', () => {
  it('says what it does, and what to type to confirm', () => {
    renderPrompt()

    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    expect(prompt).toHaveTextContent('Delete the run?')
    expect(prompt).toHaveTextContent('Type 573af861 to confirm')
  })

  it('confirms only once the text is typed exactly', () => {
    const { input, button, onConfirm } = renderPrompt()
    expect(button).toBeDisabled()

    fireEvent.change(input, { target: { value: '573AF861' } })
    expect(button).toBeDisabled()
    fireEvent.change(input, { target: { value: '573af86' } })
    fireEvent.submit(input)
    expect(onConfirm).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '573af861' } })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('shows that it is working, once only, while the action runs', async () => {
    let finish = () => {}
    const { input, button, onConfirm } = renderPrompt(
      () => new Promise<void>((resolve) => (finish = resolve)),
    )
    fireEvent.change(input, { target: { value: '573af861' } })

    fireEvent.click(button)
    fireEvent.submit(input)

    expect(await screen.findByText('Hold on.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Working...' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(onConfirm).toHaveBeenCalledTimes(1)
    await act(async () => finish())
  })

  it('shows why the action failed, and lets it be tried again', async () => {
    let fail = true
    const { input, button, onConfirm } = renderPrompt(() =>
      fail ? Promise.reject(new ApiError(403, 'forbidden', 'No')) : Promise.resolve(),
    )
    fireEvent.change(input, { target: { value: '573af861' } })

    fireEvent.click(button)

    expect(await screen.findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })

  it('cancels with its button, or Escape', () => {
    const { input, onCancel } = renderPrompt()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('confirms at once without a text to type, the focus starting on Cancel', () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    const onCancel = vi.fn()
    render(
      <ConfirmDelete confirmLabel="Revoke" scope="read" onConfirm={onConfirm} onCancel={onCancel}>
        <p>Revoke the key?</p>
      </ConfirmDelete>,
      providers(),
    )

    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    expect(prompt).toHaveAccessibleDescription('Revoke the key?')
    expect(prompt).not.toHaveTextContent('to confirm')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('cannot confirm without the scope the action needs, saying why', () => {
    const onConfirm = vi.fn(() => Promise.resolve())
    render(
      <ConfirmDelete confirmLabel="Revoke" scope="admin" onConfirm={onConfirm} onCancel={() => {}}>
        <p>Revoke the key?</p>
      </ConfirmDelete>,
      providers(),
    )

    const button = screen.getByRole('button', { name: 'Revoke' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute(
      'title',
      "Needs an API token with the 'admin' scope. Set one in Settings.",
    )
    fireEvent.submit(screen.getByRole('form', { name: 'Confirmation' }))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
