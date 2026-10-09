import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { ErrorMessage, Loading } from './feedback'

describe('ErrorMessage', () => {
  it("shows the API's message", () => {
    render(<ErrorMessage error={new ApiError(404, 'not_found', "Machine 'foo' not found")} />)

    expect(screen.getByRole('alert')).toHaveTextContent("Machine 'foo' not found")
  })

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
  ])('reports a %i as a denied permission, whatever the API said', (status, code) => {
    render(<ErrorMessage error={new ApiError(status, code, 'Invalid token')} />)

    expect(screen.getByRole('alert').textContent).toBe(
      'Permission denied. Set an API token with the required scope in Settings.',
    )
  })

  it('shows the message of an error that is not from the API', () => {
    render(<ErrorMessage error={new TypeError('Failed to fetch dynamically imported module')} />)

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module')
  })

  it('has something to say about anything else that was thrown', () => {
    render(<ErrorMessage error="nope" />)

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.')
  })

  it('offers to try again', () => {
    const retry = vi.fn()
    render(<ErrorMessage error={new ApiError(500, 'internal_error', 'Boom')} onRetry={retry} />)

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(retry).toHaveBeenCalledOnce()
  })

  it('does not offer to try again what does not exist', () => {
    render(<ErrorMessage error={new ApiError(404, 'not_found', 'Nope')} onRetry={() => {}} />)

    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})

describe('Loading', () => {
  it('announces that something is loading', () => {
    render(<Loading />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading...')
  })

  it('can say what is loading', () => {
    render(<Loading label="Loading machines..." />)

    expect(screen.getByRole('status')).toHaveTextContent('Loading machines...')
  })
})
