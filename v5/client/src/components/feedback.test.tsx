import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { ErrorMessage, Loaded, Loading } from './feedback'

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

  it('says what could not be done before why, when told', () => {
    const error = new ApiError(500, 'internal_error', 'The server failed.')
    render(<ErrorMessage error={error} context="The tests could not be listed" />)

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The tests could not be listed: The server failed.',
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

describe('Loaded', () => {
  const show = (data: string) => <p>{data}</p>
  const failure = new ApiError(500, 'internal_error', 'Boom')

  it('says that the data is loading until it arrives, then shows it', () => {
    const { rerender } = render(
      <Loaded data={undefined} error={null} onRetry={() => {}} label="Loading machines...">
        {show}
      </Loaded>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Loading machines...')

    rerender(
      <Loaded data="m1" error={null} onRetry={() => {}}>
        {show}
      </Loaded>,
    )
    expect(screen.getByText('m1')).toBeInTheDocument()
  })

  it('shows why the data could not be fetched, with what could not be loaded', () => {
    render(
      <Loaded data={undefined} error={failure} onRetry={() => {}} context="No machines">
        {show}
      </Loaded>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('No machines: Boom')
  })

  it('keeps the data shown when fetching it again fails (AR7)', () => {
    render(
      <Loaded data="m1" error={failure} onRetry={() => {}}>
        {show}
      </Loaded>,
    )

    expect(screen.getByText('m1')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the failure in place of data that no longer exists', () => {
    render(
      <Loaded data="m1" error={new ApiError(404, 'not_found', 'Gone')} onRetry={() => {}}>
        {show}
      </Loaded>,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('Gone')
    expect(screen.queryByText('m1')).not.toBeInTheDocument()
  })
})
