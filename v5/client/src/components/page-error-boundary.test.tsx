import { fireEvent, screen } from '@testing-library/react'
import { Link, Route, Routes, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageErrorBoundary } from './page-error-boundary'
import { renderWithProviders } from '../test/render'

function Broken(): never {
  throw new TypeError('Failed to fetch dynamically imported module')
}

let failing = false

/** Fails while `failing` is set, as a page does while the server it needs is down. */
function Flaky() {
  if (failing) throw new Error('Flaky failure')
  return <p>Recovered</p>
}

function Pages() {
  const { key } = useLocation()
  return (
    <>
      <Link to="/fine">Elsewhere</Link>
      <Link to="/flaky">Same page</Link>
      <PageErrorBoundary resetKey={key}>
        <Routes>
          <Route path="/broken" element={<Broken />} />
          <Route path="/flaky" element={<Flaky />} />
          <Route path="/fine" element={<p>Fine</p>} />
        </Routes>
      </PageErrorBoundary>
    </>
  )
}

describe('PageErrorBoundary', () => {
  afterEach(() => vi.restoreAllMocks())

  it('shows what a page threw, and renders the next page normally', () => {
    // React reports every error a boundary catches; this one is expected.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderWithProviders(<Pages />, { url: '/broken' })

    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch dynamically imported module')
    expect(screen.getByText('Reload the page to try again.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('link', { name: 'Elsewhere' }))
    expect(screen.getByText('Fine')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('renders the page again when the user navigates to it again', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    failing = true
    renderWithProviders(<Pages />, { url: '/flaky' })
    expect(screen.getByRole('alert')).toHaveTextContent('Flaky failure')

    failing = false
    fireEvent.click(screen.getByRole('link', { name: 'Same page' }))
    expect(screen.getByText('Recovered')).toBeInTheDocument()
  })
})
