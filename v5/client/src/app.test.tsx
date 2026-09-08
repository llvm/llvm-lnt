import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router'
import App from './app'

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  )
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
})

describe('routing', () => {
  it.each([
    ['/', 'Dashboard'],
    ['/suites', 'Test Suites'],
    ['/suites/nts', 'Test Suites'],
    ['/suites/nts/machines/linux-x86_64', 'Machine Detail'],
    ['/suites/nts/runs/550e8400-e29b-41d4-a716-446655440000', 'Run Detail'],
    ['/suites/nts/commits/abc123', 'Commit Detail'],
    ['/suites/nts/regressions/550e8400-e29b-41d4-a716-446655440000', 'Regression Detail'],
    ['/graph', 'Graph'],
    ['/compare', 'Compare'],
    ['/profiles', 'Profiles'],
    ['/admin', 'Admin'],
  ])('renders %s as the %s page', (path, heading) => {
    renderAt(path)

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(heading)
  })

  it('falls back to a not-found page for an unknown route', () => {
    renderAt('/nope')

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found')
  })
})
