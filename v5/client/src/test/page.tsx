/**
 * Helpers for tests that render whole pages of the app, against the mocked API: the app at a URL,
 * the URL it is at, and mocks of the suite-scoped endpoints most pages read.
 */

import type { ReactNode } from 'react'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { Outlet, useLocation, useNavigate } from 'react-router'
import { expect } from 'vitest'
import { routes } from '../app'
import type { Schemas } from '../api/client'
import type { SuiteSchema } from '../api/suites'
import { INACTIVITY_HELP } from '../inactivity'
import type { Commit } from '../schema'
import { BARE_SUITE, SUITE, cursorPage } from './fixtures'
import { mockApi, type Operation, type PathWith, type RequestBody } from './mock-api'
import { renderRoutes } from './render'
import { server } from './server'

export type Page<Item> = ReturnType<typeof cursorPage<Item>>
export type Respond<Body> = (query: URLSearchParams) => Body | Promise<Body>

/**
 * The app at `url`, with the URL it is at shown, as `currentUrl` reads it, Back and Forward
 * buttons, and `extra`.
 */
export function renderPage(url: string, extra?: ReactNode) {
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
  return renderRoutes(
    [
      {
        element: (
          <>
            <Outlet />
            <ShowUrl />
            {extra}
          </>
        ),
        children: routes,
      },
    ],
    { url },
  )
}

/** Queries within the page's content, rather than the navbar, which has links of its own. */
export function main() {
  return within(screen.getByRole('main'))
}

/** The link named `name` in the navbar, the first navigation landmark of the page. */
export function navbarLink(name: string) {
  return within(screen.getAllByRole('navigation')[0]).getByRole('link', { name })
}

/** Queries within the breadcrumb trail of a detail page (see SuiteTrail). */
export function trail() {
  return within(screen.getByRole('navigation', { name: 'Breadcrumb' }))
}

/** The link named `name` in the breadcrumb trail of a detail page. */
export function trailLink(name: string) {
  return trail().getByRole('link', { name })
}

export function currentUrl() {
  return screen.getByTestId('url').textContent
}

/** The query of the URL the page is at, by parameter, whatever their order. */
export function query() {
  const params = new URLSearchParams(currentUrl()!.split('?')[1] ?? '')
  const entries: Record<string, string[]> = {}
  for (const [key, value] of params) (entries[key] ??= []).push(value)
  return entries
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

/** Answer `GET /trends` with `respond`'s items; returns its queries. */
export function mockTrends(respond: Respond<Schemas['TrendPoint'][]>) {
  const { queries, answer } = recording(respond)
  server.use(
    mockApi('get', '/api/suites/{testsuite}/trends', async ({ request }) =>
      HttpResponse.json({ items: await answer(request) }),
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

/** Answer `POST regressions` with `created`; returns each request's suite and body. */
export function mockCreateRegression(created: Schemas['RegressionDetail']) {
  const requests: { suite: string; body: Schemas['RegressionCreate'] }[] = []
  server.use(
    mockApi('post', '/api/suites/{testsuite}/regressions', async ({ request, params }) => {
      requests.push({ suite: params.testsuite, body: await request.json() })
      return HttpResponse.json(created, { status: 201 })
    }),
  )
  return requests
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

/** Wait for what a render sends to go out and be answered, to check that nothing changes. */
export function settle() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 50)))
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

/** Replace the text of `input` with `text`, as typing it would. */
export function typeInto(input: HTMLElement, text: string) {
  fireEvent.change(input, { target: { value: text } })
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
/**
 * The value cell of a Delete after inactivity row showing `value` (DT1, DT3): its text and Edit
 * button, then what describes them to assistive technology: without the scope to edit it, the
 * reason, and its help.
 */
export function inactivityCell(value: string) {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return expect.stringMatching(
    new RegExp(`^${literal(`${value}Edit`)}.*${literal(INACTIVITY_HELP)}$`),
  )
}

export async function infoRows(name: string) {
  const box = await screen.findByRole('group', { name })
  return [...box.querySelectorAll('dt')].map((label) => [
    label.textContent,
    label.nextElementSibling!.textContent,
  ])
}
