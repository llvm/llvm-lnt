import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, PERMISSION_DENIED } from '../api/client'
import { ConfirmDelete } from './confirm-delete'

function renderPrompt(onConfirm: () => Promise<unknown> = () => Promise.resolve()) {
  const onCancel = vi.fn()
  const confirm = vi.fn(onConfirm)
  render(
    <ConfirmDelete
      expected="573af861"
      onConfirm={confirm}
      onCancel={onCancel}
      busyMessage="Hold on."
    >
      <p>Delete the run?</p>
    </ConfirmDelete>,
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
})
