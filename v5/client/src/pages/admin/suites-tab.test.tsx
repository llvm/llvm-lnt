import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { signIn, TOKEN } from '../../test/auth'
import { mockClipboard } from '../../test/clipboard'
import { BARE_SUITE, SUITE } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  headersOf,
  main,
  mockSuites,
  renderPage,
  rowsOf,
  table,
  type SuiteStore,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import { downloadFile } from './download'

vi.mock('./download', () => ({ downloadFile: vi.fn() }))

/** A suite whose only metric has no unit at all. */
const UNITLESS: SuiteSchema = {
  name: 'units',
  metrics: [
    {
      name: 'neither',
      type: 'datetime',
      display_name: null,
      unit: null,
      unit_abbrev: null,
      bigger_is_better: false,
    },
  ],
  commit_fields: [],
  machine_fields: [],
}

const SUITES = [SUITE, BARE_SUITE, UNITLESS]

type Failure = ReturnType<typeof errorResponse>

/**
 * Answer `DELETE /api/suites/{name}` by deleting the suite from `store` once `wait` resolves, or
 * with `fail`; returns each request's suite, `confirm` and `Authorization`.
 */
function mockDelete(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { name: string; confirm: string | null; auth: string | null }[] = []
  server.use(
    mockApi('delete', '/api/suites/{name}', async ({ request, params }) => {
      sent.push({
        name: params.name,
        confirm: new URL(request.url).searchParams.get('confirm'),
        auth: request.headers.get('Authorization'),
      })
      await wait?.()
      if (fail) return fail()
      store.suites = store.suites.filter((suite) => suite.name !== params.name)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return sent
}

function suiteSelect() {
  return selectButton('Test suite')
}

/** The names of the dropdown's options, opening it. */
async function optionsOf() {
  await userEvent.setup().click(suiteSelect())
  return screen.getAllByRole('option').map((option) => option.textContent)
}

function deleteButton() {
  return screen.getByRole('button', { name: 'Delete This Suite' })
}

function prompt() {
  return screen.queryByRole('form', { name: 'Confirmation' })
}

/** Confirm the deletion of `name`, as the prompt asks: by typing it. */
function confirmDeletion(name: string) {
  fireEvent.change(within(prompt()!).getByRole('textbox'), { target: { value: name } })
  fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))
}

/**
 * Show the suite `name`, among `suites`, without a token, or to a holder of a `manage` token, ready
 * to delete it.
 */
async function renderSuite(
  name = 'libcxx',
  { manage = false, suites = SUITES }: { manage?: boolean; suites?: SuiteSchema[] } = {},
) {
  if (manage) signIn('manage')
  const store = mockSuites(suites)
  const rendered = renderPage(`/admin?tab=suites&suite=${name}`)
  await table('Metrics')
  if (manage) await waitFor(() => expect(deleteButton()).toBeEnabled())
  return { ...rendered, store }
}

describe('the Test Suites tab', () => {
  it('offers every suite, and selects none until asked', async () => {
    mockSuites(SUITES)
    renderPage('/admin?tab=suites')

    await waitFor(() => expect(suiteSelect()).toHaveTextContent('Select a suite'))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    expect(await optionsOf()).toEqual(['Select a suite', 'libcxx', 'nts', 'units'])
    await userEvent.setup().keyboard('{Escape}')

    await pickOption('Test suite', 'nts')
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites&suite=nts'))
    expect(await table('Metrics')).toBeInTheDocument()

    await pickOption('Test suite', 'Select a suite')
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows the schema of the suite in the URL, each list with its own columns', async () => {
    mockSuites(SUITES)
    renderPage('/admin?tab=suites&suite=libcxx')

    const metrics = await table('Metrics')
    expect(suiteSelect()).toHaveTextContent('libcxx')
    expect(headersOf(metrics)).toEqual(['Name', 'Type', 'Display Name', 'Unit', 'Bigger is Better'])
    expect(rowsOf(metrics)).toEqual(['execution_time | real | Execution Time | seconds (s) | No'])

    const commitFields = await table('Commit fields')
    expect(headersOf(commitFields)).toEqual([
      'Name',
      'Type',
      'Display Name',
      'Searchable',
      'Display',
    ])
    expect(rowsOf(commitFields)).toEqual([
      'svn_revision | text | -- | Yes | Yes',
      'commit_info | text | -- | No | No',
    ])

    const machineFields = await table('Machine fields')
    expect(headersOf(machineFields)).toEqual(['Name', 'Type', 'Display Name', 'Searchable'])
    expect(rowsOf(machineFields)).toEqual([
      'hardware | text | Hardware | Yes',
      'os | text | -- | Yes',
      'core_count | integer | Cores | No',
    ])

    expect(main().getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Metrics',
      'Commit Fields',
      'Machine Fields',
    ])
  })

  it('writes -- for a metric with no unit, as for an unset display name', async () => {
    mockSuites(SUITES)
    renderPage('/admin?tab=suites&suite=units')

    expect(rowsOf(await table('Metrics'))).toEqual(['neither | datetime | -- | -- | No'])
  })

  it('says when a list of the schema is empty', async () => {
    mockSuites(SUITES)
    renderPage('/admin?tab=suites&suite=nts')

    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
    expect(rowsOf(await table('Commit fields'))).toEqual(['No commit fields.'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['No machine fields.'])
  })

  it('drops a suite that does not exist from the URL', async () => {
    mockSuites(SUITES)
    renderPage('/admin?tab=suites&suite=nope')

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(suiteSelect()).toHaveTextContent('Select a suite')
  })

  it('keeps the suite in the URL while the list loads, and when it fails, which it retries', async () => {
    const list = gate()
    server.use(
      mockApi('get', '/api/suites', async () => {
        await list.promise
        return errorResponse(500, 'internal_error', 'The database is down.')
      }),
    )
    renderPage('/admin?tab=suites&suite=libcxx')

    expect(await main().findByText('Loading test suites...')).toBeInTheDocument()
    await act(async () => list.open())
    expect(await main().findByRole('alert')).toHaveTextContent('The database is down.')
    expect(currentUrl()).toBe('/admin?tab=suites&suite=libcxx')

    mockSuites(SUITES)
    fireEvent.click(main().getByRole('button', { name: 'Retry' }))
    expect(await table('Metrics')).toBeInTheDocument()
    expect(currentUrl()).toBe('/admin?tab=suites&suite=libcxx')
  })

  it('says when there are no suites, with no dropdown', async () => {
    mockSuites([])
    renderPage('/admin?tab=suites')

    expect(await main().findByText('There are no test suites yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: / Test suite$/ })).not.toBeInTheDocument()
  })

  it('drops the suite on leaving the tab', async () => {
    await renderSuite('libcxx')

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(screen.queryByRole('table', { name: 'Metrics' })).not.toBeInTheDocument()
  })

  it('drops a suite from the URL of the API Keys tab', async () => {
    renderPage('/admin?suite=libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/admin'))
  })
})

describe('exporting a schema', () => {
  const JSON_TEXT = JSON.stringify(SUITE, null, 2)

  it('is allowed to anyone, unlike deleting the suite', async () => {
    await renderSuite('libcxx')

    expect(screen.getByRole('button', { name: 'Copy as JSON' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeEnabled()
    expect(deleteButton()).toBeDisabled()
    expect(deleteButton()).toHaveAttribute('title', expect.stringContaining("'manage' scope"))
  })

  it('copies the schema as the API returned it', async () => {
    const writeText = mockClipboard()
    await renderSuite()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as JSON' }))

    expect(await main().findByRole('button', { name: 'Copied.' })).toBeInTheDocument()
    expect(writeText).toHaveBeenCalledWith(JSON_TEXT)
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(SUITE)
  })

  it('downloads it as a file named after the suite', async () => {
    await renderSuite('libcxx')

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }))

    expect(downloadFile).toHaveBeenCalledWith('libcxx.json', `${JSON_TEXT}\n`, 'application/json')
  })
})

describe('deleting a suite', () => {
  it('asks for its name, deletes it, and forgets it, selecting no suite', async () => {
    const { store, queryClient } = await renderSuite('libcxx', { manage: true })
    // Something read from inside the suite, which a suite created later under its name must not
    // find.
    queryClient.setQueryData([...queryKeys.machines('libcxx'), 'detail', 'm'], { name: 'm' })
    const sent = mockDelete(store)

    fireEvent.click(deleteButton())
    expect(deleteButton()).toHaveAttribute('aria-expanded', 'true')
    expect(prompt()).toHaveTextContent(
      'Deleting the test suite libcxx permanently destroys all of its machines, runs, commits, ' +
        'samples and regressions. This cannot be undone.',
    )
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
    confirmDeletion('libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(sent).toEqual([{ name: 'libcxx', confirm: 'true', auth: `Bearer ${TOKEN}` }])
    expect(screen.queryByRole('table', { name: 'Metrics' })).not.toBeInTheDocument()
    expect(prompt()).not.toBeInTheDocument()
    await waitFor(() => expect(suiteSelect()).toHaveFocus())
    expect(await optionsOf()).toEqual(['Select a suite', 'nts', 'units'])
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.suite('libcxx') })).toEqual([])
  })

  it('says that deleting may take a while, while it does', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = gate()
    mockDelete(store, { wait: () => deletion.promise })
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')

    expect(
      await within(prompt()!).findByText('Deleting a suite with much data may take a while.'),
    ).toBeInTheDocument()
    await act(async () => deletion.open())
  })

  it('says that no suite is left once the last is deleted, and focuses that', async () => {
    const { store } = await renderSuite('nts', { manage: true, suites: [BARE_SUITE] })
    mockDelete(store)
    fireEvent.click(deleteButton())

    confirmDeletion('nts')

    const note = await main().findByText('There are no test suites yet.')
    await waitFor(() => expect(note).toHaveFocus())
  })

  it('sends nothing when cancelled, and gives the focus back to its button', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const sent = mockDelete(store)
    fireEvent.click(deleteButton())

    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(deleteButton()).toHaveFocus()
    expect(sent).toEqual([])
  })

  it('shows why the suite could not be deleted, in the prompt', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    mockDelete(store, { fail: () => errorResponse(409, 'retry', 'Try again.') })
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent('Try again.')
    expect(currentUrl()).toBe('/admin?tab=suites&suite=libcxx')
  })

  it('takes a suite deleted meanwhile, from elsewhere, as deleted', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    mockDelete(store, { fail: () => errorResponse(404, 'not_found', "No suite 'libcxx'.") })
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    await waitFor(() => expect(suiteSelect()).toHaveFocus())
    expect(await optionsOf()).toEqual(['Select a suite', 'nts', 'units'])
  })

  it('does not bring the suite back from a list on its way when it is deleted', async () => {
    const { store, queryClient } = await renderSuite('libcxx', { manage: true })
    const stale = gate()
    const refetched = mockSuites(SUITES, { wait: () => stale.promise })
    void queryClient.refetchQueries({ queryKey: queryKeys.suites })
    await waitFor(() => expect(refetched.requests).toBe(1))
    mockDelete(store)
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    await act(async () => stale.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(await optionsOf()).toEqual(['Select a suite', 'nts', 'units'])
  })

  it('leaves another suite selected meanwhile as it is, and the focus where it is', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = gate()
    mockDelete(store, { wait: () => deletion.promise })
    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')
    await within(prompt()!).findByText('Deleting a suite with much data may take a while.')

    await pickOption('Test suite', 'units')
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites&suite=units'))
    const metrics = await table('Metrics')
    screen.getByRole('button', { name: 'Copy as JSON' }).focus()
    await act(async () => deletion.open())

    await waitFor(() => expect(store.suites.map((suite) => suite.name)).not.toContain('libcxx'))
    expect(currentUrl()).toBe('/admin?tab=suites&suite=units')
    expect(metrics).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy as JSON' })).toHaveFocus()
  })

  it('forgets the suite when the tab was left meanwhile, without taking the focus', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = gate()
    mockDelete(store, { wait: () => deletion.promise })
    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')
    await within(prompt()!).findByText('Deleting a suite with much data may take a while.')

    const apiKeys = screen.getByRole('tab', { name: 'API Keys' })
    fireEvent.click(apiKeys)
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    apiKeys.focus()
    await act(async () => deletion.open())

    await waitFor(() => expect(store.suites.map((suite) => suite.name)).not.toContain('libcxx'))
    expect(apiKeys).toHaveFocus()
    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
    await waitFor(() => expect(suiteSelect()).toBeInTheDocument())
    expect(await optionsOf()).toEqual(['Select a suite', 'nts', 'units'])
  })
})
