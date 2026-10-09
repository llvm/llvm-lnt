/**
 * Helpers for tests that render whole pages of the app, against the mocked API: the app at a URL,
 * the URL it is at, and mocks of the suite-scoped endpoints most pages read.
 */

import { fireEvent, screen, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { useLocation, useNavigate } from 'react-router'
import App from '../app'
import type { Schemas } from '../api/client'
import type { SuiteSchema } from '../api/suites'
import type { Commit } from '../schema'
import { BARE_SUITE, SUITE, cursorPage } from './fixtures'
import { mockApi } from './mock-api'
import { renderWithProviders } from './render'
import { server } from './server'

export type Page<Item> = ReturnType<typeof cursorPage<Item>>
export type Respond<Body> = (query: URLSearchParams) => Body | Promise<Body>

/** The app at `url`, with the URL it is at shown, as `currentUrl` reads it, and a Back button. */
export function renderPage(url: string) {
  function ShowUrl() {
    const { pathname, search } = useLocation()
    const navigate = useNavigate()
    return (
      <>
        <output data-testid="url">{pathname + search}</output>
        <button onClick={() => navigate(-1)}>Browser back</button>
      </>
    )
  }
  return renderWithProviders(
    <>
      <App />
      <ShowUrl />
    </>,
    { url },
  )
}

export function currentUrl() {
  return screen.getByTestId('url').textContent
}

export function mockSuites(items: SuiteSchema[] = [SUITE, BARE_SUITE]) {
  server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items })))
}

/** The query of every request `mock` answers, in order. */
export function recording<Body>(respond: Respond<Body>) {
  const queries: URLSearchParams[] = []
  const answer = async (request: Request) => {
    const query = new URL(request.url).searchParams
    queries.push(query)
    return respond(query)
  }
  return { queries, answer }
}

export function mockRuns(respond: Respond<Page<Schemas['Run']>>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/runs', async ({ request }) =>
      HttpResponse.json(await answer(request)),
    ),
  )
  return queries
}

export function mockMachines(respond: Respond<Schemas['MachineOffsetPage']>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/machines', async ({ request }) =>
      HttpResponse.json(await answer(request)),
    ),
  )
  return queries
}

export function mockCommits(respond: Respond<Page<Commit>>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/commits', async ({ request }) =>
      HttpResponse.json(await answer(request)),
    ),
  )
  return queries
}

export function mockRegressions(
  respond: Respond<Page<Schemas['Regression']>> = () => cursorPage([]),
) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/regressions', async ({ request }) =>
      HttpResponse.json(await answer(request)),
    ),
  )
  return queries
}

/** Resolve the commits among `known`; returns the commits each request asked for. */
export function mockResolve(known: Commit[] = []) {
  const requests: string[][] = []
  server.use(
    mockApi('post', '/api/suites/{testsuite}/commits/resolve', async ({ request }) => {
      const { commits } = await request.json()
      requests.push(commits)
      const found = known.filter((c) => commits.includes(c.value))
      return HttpResponse.json({
        results: Object.fromEntries(found.map((c) => [c.value, c])),
        not_found: commits.filter((value) => !found.some((c) => c.value === value)),
      })
    }),
  )
  return requests
}

/** A promise, and the function that settles it. */
export function gate() {
  let open = () => {}
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}

export function table(name: string) {
  return screen.findByRole('table', { name })
}

/** The text of each body row of `table`, one string per row, its cells separated by ` | `. */
export function rowsOf(table: HTMLElement) {
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent)
        .join(' | '),
    )
}

export function search(label: string, text: string) {
  fireEvent.change(screen.getByRole('searchbox', { name: label }), { target: { value: text } })
}
