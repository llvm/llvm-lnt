import { fireEvent, screen } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { routes } from './app'
import { queryKeys } from './api/keys'
import { errorResponse, mockApi } from './test/mock-api'
import { mockSuites } from './test/page'
import { renderRoutes } from './test/render'
import { INDEX, server } from './test/server'

// Every page so far starts from the list of suites, and asks for nothing else without one.
beforeEach(() => mockSuites([]))

// The Graph page shows its chart before it has anything to plot.
vi.mock('./components/chart', () => import('./test/chart'))

function renderAt(url: string) {
  return renderRoutes(routes, { url })
}

describe('navbar', () => {
  it('links to every top-level page', () => {
    renderAt('/')

    expect(screen.getByRole('link', { name: 'LNT' })).toHaveAttribute('href', '/')
    expect(screen.getByRole('link', { name: 'Test Suites' })).toHaveAttribute('href', '/suites')
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute('href', '/graph')
    expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute('href', '/compare')
    expect(screen.getByRole('link', { name: 'Profiles' })).toHaveAttribute('href', '/profiles')
    expect(screen.getByRole('link', { name: 'Admin' })).toHaveAttribute('href', '/admin')
  })

  it.each([
    ['/suites/nts'],
    ['/suites/nts/machines/linux-x86_64'],
    ['/suites/nts/runs/550e8400-e29b-41d4-a716-446655440000'],
  ])('passes the suite of %s on to the suite-agnostic pages (AR4)', (url) => {
    renderAt(url)

    expect(screen.getByRole('link', { name: 'Test Suites' })).toHaveAttribute('href', '/suites/nts')
    expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute('href', '/graph?suite=nts')
    expect(screen.getByRole('link', { name: 'Compare' })).toHaveAttribute(
      'href',
      '/compare?suite_a=nts',
    )
    expect(screen.getByRole('link', { name: 'Profiles' })).toHaveAttribute(
      'href',
      '/profiles?suite_a=nts',
    )
  })

  it.each([['/graph?suite=nts'], ['/admin']])(
    'passes no suite on from the suite-agnostic page %s',
    (url) => {
      renderAt(url)

      expect(screen.getByRole('link', { name: 'Test Suites' })).toHaveAttribute('href', '/suites')
      expect(screen.getByRole('link', { name: 'Graph' })).toHaveAttribute('href', '/graph')
    },
  )

  it('has a Settings button rather than a link', () => {
    renderAt('/')

    expect(screen.getByRole('button', { name: 'Settings' })).toBeEnabled()
  })

  it('opens the API documentation viewer in a new tab', () => {
    renderAt('/')

    const api = screen.getByRole('link', { name: 'API' })
    expect(api).toHaveAttribute('href', '/api/docs')
    expect(api).toHaveAttribute('target', '_blank')
    expect(api).toHaveAttribute('rel', 'noopener noreferrer')
  })
})

describe('footer', () => {
  function mockRevision(revision: string | null) {
    server.use(mockApi('get', '/api', () => HttpResponse.json({ ...INDEX, revision })))
  }

  it("names the server's revision, linking to its commit in a new tab (AR4)", async () => {
    mockRevision('0dd267f1')
    renderAt('/')

    const link = await screen.findByRole('link', { name: '0dd267f1' })
    expect(link).toHaveAttribute('href', 'https://github.com/llvm/llvm-lnt/commit/0dd267f1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/^LNT v5 · 0dd267f1$/)
  })

  it.each<[string, () => Response]>([
    ['the server does not know its revision', () => HttpResponse.json(INDEX)],
    ['the index cannot be fetched', () => errorResponse(500, 'internal', 'Boom.')],
  ])('shows LNT v5 alone, reporting nothing, when %s', async (_, respond) => {
    server.use(mockApi('get', '/api', respond))
    const { queryClient } = renderAt('/')

    await vi.waitFor(() =>
      expect(queryClient.getQueryState(queryKeys.index)?.status).not.toBe('pending'),
    )
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/^LNT v5$/)
    expect(screen.queryByText('Boom.')).not.toBeInTheDocument()
  })

  // AR4's behaviour, whatever keeps the footer from asking again: the footer staying mounted, or
  // the query never going stale.
  it('keeps the revision the page was loaded with as it navigates', async () => {
    mockRevision('0dd267f1')
    renderAt('/')
    await screen.findByRole('link', { name: '0dd267f1' })

    // A deploy since: the page still runs the client it was loaded with.
    mockRevision('5b5dae40')
    fireEvent.click(screen.getByRole('link', { name: 'Admin' }))

    await screen.findByRole('heading', { level: 1, name: 'Admin' })
    expect(screen.getByRole('contentinfo')).toHaveTextContent(/^LNT v5 · 0dd267f1$/)
  })
})

describe('routing', () => {
  it.each([
    ['/', 'Dashboard'],
    ['/suites', 'Test Suites'],
    ['/suites/nts', 'Test Suites'],
    ['/suites/nts/machines/linux-x86_64', 'Machine: linux-x86_64'],
    ['/suites/nts/runs/550e8400-e29b-41d4-a716-446655440000', 'Run: 550e8400'],
    ['/suites/nts/commits/abc123', 'Commit: abc123'],
    ['/suites/nts/regressions/550e8400-e29b-41d4-a716-446655440000', 'Regression: 550e8400'],
    ['/graph', 'Graph'],
    ['/compare', 'Compare'],
    ['/profiles', 'Profiles'],
    ['/admin', 'Admin'],
  ])('renders %s as the %s page', async (path, heading) => {
    renderAt(path)

    // Pages are loaded on first use (AR2 "Code splitting"), so the heading arrives after the first
    // render.
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(heading)
  })

  it('falls back to a not-found page for an unknown route', async () => {
    renderAt('/nope')

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Page not found')
  })
})
