/**
 * Helpers for tests that render whole pages of the app, against the mocked API: the app at a URL,
 * the URL it is at, and mocks of the suite-scoped endpoints most pages read.
 */

import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { useLocation, useNavigate } from 'react-router'
import { expect } from 'vitest'
import App from '../app'
import type { Schemas } from '../api/client'
import type { SuiteSchema } from '../api/suites'
import type { Commit } from '../schema'
import { BARE_SUITE, SUITE, cursorPage } from './fixtures'
import { mockApi, type Operation, type PathWith, type RequestBody } from './mock-api'
import { renderWithProviders } from './render'
import { server } from './server'

export type Page<Item> = ReturnType<typeof cursorPage<Item>>
export type Respond<Body> = (query: URLSearchParams) => Body | Promise<Body>

/**
 * The app at `url`, with the URL it is at shown, as `currentUrl` reads it, and Back and Forward
 * buttons.
 */
export function renderPage(url: string) {
  function ShowUrl() {
    const { pathname, search } = useLocation()
    const navigate = useNavigate()
    return (
      <>
        <output data-testid="url">{pathname + search}</output>
        <button onClick={() => navigate(-1)}>Browser back</button>
        <button onClick={() => navigate(1)}>Browser forward</button>
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

/** Queries within the page's content, rather than the navbar, which has links of its own. */
export function main() {
  return within(screen.getByRole('main'))
}

export function currentUrl() {
  return screen.getByTestId('url').textContent
}

/** The suites the mocked API holds, as it lists them, and how many times it was asked. */
export interface SuiteStore {
  suites: SuiteSchema[]
  requests: number
}

/**
 * Answer `GET /api/suites` with the suites the returned store holds when the request arrives,
 * `items` at first, once `wait` resolves.
 */
export function mockSuites(
  items: SuiteSchema[] = [SUITE, BARE_SUITE],
  { wait }: { wait?: () => Promise<void> } = {},
): SuiteStore {
  const store: SuiteStore = { suites: [...items], requests: 0 }
  server.use(
    mockApi('get', '/api/suites', async () => {
      store.requests++
      const listed = [...store.suites]
      await wait?.()
      return HttpResponse.json({ items: listed })
    }),
  )
  return store
}

/**
 * Answer every `method path` request with `respond`; returns the body each was sent with, and the
 * `Authorization` header, in order.
 */
export function mockSent<M extends 'post' | 'patch' | 'delete', P extends PathWith<M>>(
  method: M,
  path: P,
  respond: (body: RequestBody<Operation<M, P>>) => Response | Promise<Response>,
) {
  const sent: { body: RequestBody<Operation<M, P>>; auth: string | null }[] = []
  server.use(
    mockApi(method, path, async ({ request }) => {
      const body = await request.json()
      sent.push({ body, auth: request.headers.get('Authorization') })
      return respond(body)
    }),
  )
  return sent
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

export function mockMachines(respond: Respond<Schemas['MachineList']>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/machines', async ({ request }) =>
      HttpResponse.json(await answer(request)),
    ),
  )
  return queries
}

export function mockTests(respond: Respond<Page<Schemas['Test']>>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/tests', async ({ request }) =>
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

/** The text of each header of `table`. */
export function headersOf(table: HTMLElement) {
  return within(table)
    .getAllByRole('columnheader')
    .map((header) => header.textContent)
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

/** The query of `link`'s target, as an object. */
export function queryOf(link: HTMLElement) {
  return Object.fromEntries(new URL(link.getAttribute('href')!, 'http://x').searchParams)
}

/** The Edit button of the field `field`, edited in place (see InlineEdit). */
export function editButton(field: string) {
  return screen.getByRole('button', { name: `Edit ${field}` })
}

/** Edit the field `field`, typing `text`, and save it. */
export function save(field: string, text: string) {
  fireEvent.click(editButton(field))
  const input = screen.getByRole('textbox', { name: field })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input)
}

/**
 * Wait for the info box named `name` to show, and for `control` to be enabled once the token's
 * check has accepted the scope it needs.
 */
export async function ready(name: string, control: () => HTMLElement) {
  await screen.findByRole('group', { name })
  await waitFor(() => expect(control()).toBeEnabled())
}

/** The rows of the info box named `name` (see InfoBox), once it shows, as label and value text. */
export async function infoRows(name: string) {
  const box = await screen.findByRole('group', { name })
  return [...box.querySelectorAll('dt')].map((label) => [
    label.textContent,
    label.nextElementSibling!.textContent,
  ])
}
