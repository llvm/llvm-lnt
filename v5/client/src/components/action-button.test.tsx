import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ActionButton } from './action-button'

describe('ActionButton', () => {
  it('is disabled while it has a reason, which it gives on hover and to assistive technology', () => {
    const { rerender } = render(<ActionButton reason="Name the key first.">Create</ActionButton>)

    const button = screen.getByRole('button', { name: 'Create' })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Name the key first.')
    expect(button).toHaveAccessibleDescription('Name the key first.')

    rerender(<ActionButton>Create</ActionButton>)
    expect(button).toBeEnabled()
    expect(button).not.toHaveAttribute('title')
    expect(button).not.toHaveAccessibleDescription()
  })

  it('ignores clicks while busy, submitting nothing, but keeps the focus', () => {
    const onClick = vi.fn()
    const onSubmit = vi.fn((event: { preventDefault(): void }) => event.preventDefault())
    render(
      <form onSubmit={onSubmit}>
        <ActionButton type="submit" busy onClick={onClick}>
          Create
        </ActionButton>
      </form>,
    )

    const button = screen.getByRole('button', { name: 'Create' })
    button.focus()
    fireEvent.click(button)

    expect(onClick).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(button).toHaveFocus()
  })
})
