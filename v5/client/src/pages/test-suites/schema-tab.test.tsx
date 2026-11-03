import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { apiKey, mockAuth, signIn, TOKEN } from '../../test/auth'
import { mockClipboard } from '../../test/clipboard'
import { BARE_SUITE, NO_REPOSITORY, SUITE, cursorPage } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  headersOf,
  main,
  mockRuns,
  mockSuites,
  renderPage,
  rowsOf,
  settle,
  table,
  type SuiteStore,
} from '../../test/page'
import { server } from '../../test/server'
import { downloadFile } from './schema/download'

vi.mock('./schema/download', () => ({ downloadFile: vi.fn() }))

/** A suite whose only metric has no unit at all. */
const UNITLESS: SuiteSchema = {
  name: 'units',
  display_name: null,
  metrics: [
    {
      name: 'neither',
      type: 'datetime',
      display_name: null,
      unit: null,
      unit_abbrev: null,
      bigger_is_better: false,
      dashboard: false,
    },
  ],
  commit_fields: [],
  machine_fields: [],
  repository: NO_REPOSITORY,
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

/** The names of the suite picker's cards. */
function cards() {
  return within(screen.getByRole('navigation', { name: 'Test suites' }))
    .getAllByRole('link')
    .map((card) => card.textContent)
}

function card(name: string) {
  return within(screen.getByRole('navigation', { name: 'Test suites' })).getByRole('link', {
    name,
  })
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
 * Show the Schema tab of the suite `name`, among `suites`, without a token, or to a holder of a
 * `manage` token, ready to delete it. The Runs tab, which the page goes to once the suite is
 * deleted, lists no runs.
 */
async function renderSuite(
  name = 'libcxx',
  { manage = false, suites = SUITES }: { manage?: boolean; suites?: SuiteSchema[] } = {},
) {
  if (manage) signIn('manage')
  const store = mockSuites(suites)
  mockRuns(() => cursorPage([]))
  const rendered = renderPage(`/suites/${name}?tab=schema`)
  await table('Metrics')
  if (manage) await waitFor(() => expect(deleteButton()).toBeEnabled())
  return { ...rendered, store }
}

/**
 * Show libcxx's Schema tab to a holder of a `manage` token, reached from `/nope` through the
 * navbar, so that Back leaves the page.
 */
async function renderFromElsewhere() {
  signIn('manage')
  const store = mockSuites(SUITES)
  mockRuns(() => cursorPage([]))
  renderPage('/nope')
  fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
  fireEvent.click(await screen.findByRole('tab', { name: 'Schema' }))
  await waitFor(() => expect(deleteButton()).toBeEnabled())
  return store
}

/** Delete `name` from its Schema tab, its deletion held until the returned gate opens. */
async function startDeleting(name: string, store: SuiteStore) {
  const deletion = gate()
  mockDelete(store, { wait: () => deletion.promise })
  fireEvent.click(deleteButton())
  confirmDeletion(name)
  await within(prompt()!).findByText('Deleting a suite with much data may take a while.')
  return deletion
}

describe('the Schema tab', () => {
  it('shows the schema of the suite, each list with its own columns', async () => {
    mockSuites(SUITES)
    renderPage('/suites/libcxx?tab=schema')

    const metrics = await table('Metrics')
    expect(screen.getByRole('tab', { name: 'Schema' })).toHaveAttribute('aria-selected', 'true')
    expect(headersOf(metrics)).toEqual([
      'Name',
      'Type',
      'Display Name',
      'Unit',
      'Bigger is Better',
      'Dashboard',
    ])
    expect(rowsOf(metrics)).toEqual([
      'execution_time | real | Execution Time | seconds (s) | No | Yes',
    ])

    const commitFields = await table('Commit fields')
    expect(headersOf(commitFields)).toEqual([
      'Name',
      'Type',
      'Display Name',
      'Searchable',
      'Display',
      'Listed',
    ])
    expect(rowsOf(commitFields)).toEqual([
      'svn_revision | text | -- | Yes | Yes | No',
      'commit_info | text | -- | No | No | Yes',
    ])

    const machineFields = await table('Machine fields')
    expect(headersOf(machineFields)).toEqual([
      'Name',
      'Type',
      'Display Name',
      'Searchable',
      'Listed',
    ])
    expect(rowsOf(machineFields)).toEqual([
      'hardware | text | Hardware | Yes | Yes',
      'os | text | -- | Yes | No',
      'core_count | integer | Cores | No | Yes',
    ])

    expect(main().getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Suite',
      'Metrics',
      'Commit Fields',
      'Machine Fields',
      'Repository',
    ])
    // The suite by its name, and its display name, which it has none of.
    expect(screen.getByRole('group', { name: 'Suite' })).toHaveTextContent(
      'Name' + 'libcxx' + 'Display name' + '--',
    )
    // The templates as text, not links: they are not URLs until filled in.
    const repository = screen.getByRole('group', { name: 'Repository' })
    expect(repository).toHaveTextContent(
      'Label' +
        'GitHub' +
        'Commit URL' +
        'https://github.com/llvm/llvm-project/commit/{commit}' +
        'Range URL' +
        'https://github.com/llvm/llvm-project/compare/{from}...{to}',
    )
    expect(within(repository).queryByRole('link')).toBeNull()
  })

  it('writes -- for a metric with no unit, as for an unset display name', async () => {
    mockSuites(SUITES)
    renderPage('/suites/units?tab=schema')

    expect(rowsOf(await table('Metrics'))).toEqual(['neither | datetime | -- | -- | No | No'])
  })

  it('says when a list of the schema is empty', async () => {
    mockSuites(SUITES)
    renderPage('/suites/nts?tab=schema')

    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
    expect(rowsOf(await table('Commit fields'))).toEqual(['No commit fields.'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['No machine fields.'])
    expect(screen.getByRole('group', { name: 'Repository' })).toHaveTextContent(
      'Label--Commit URL--Range URL--',
    )
  })
})

describe('a manage token restricted to some suites', () => {
  async function renderRestricted(name: string) {
    signIn('manage', ['nts'])
    mockSuites(SUITES)
    renderPage(`/suites/${name}?tab=schema`)
    await table('Metrics')
  }

  it('edits and deletes a suite it lists', async () => {
    await renderRestricted('nts')

    await waitFor(() => expect(deleteButton()).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Edit schema' })).toBeEnabled()
  })

  it('neither edits nor deletes another suite', async () => {
    await renderRestricted('libcxx')

    await waitFor(() =>
      expect(deleteButton()).toHaveAttribute(
        'title',
        "Needs an API token with the 'manage' scope in suite 'libcxx'. The token in Settings " +
          "has the 'manage' scope only in suite 'nts'.",
      ),
    )
    expect(screen.getByRole('button', { name: 'Edit schema' })).toBeDisabled()
    expect(deleteButton()).toBeDisabled()
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
  it('asks for its name, deletes it, forgets it, and leaves for the first suite left', async () => {
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

    // `/suites`, without the tab, gives way to the first suite left.
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(sent).toEqual([{ name: 'libcxx', confirm: 'true', auth: `Bearer ${TOKEN}` }])
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
    expect(cards()).toEqual(['nts', 'units'])
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.suite('libcxx') })).toEqual([])
  })

  it('names the suite by its label, and asks for its name (AR22, AR16)', async () => {
    const suites = [{ ...SUITE, display_name: 'Microbenchmarks' }, BARE_SUITE, UNITLESS]
    const { store } = await renderSuite('libcxx', { manage: true, suites })
    const sent = mockDelete(store)

    fireEvent.click(deleteButton())
    expect(prompt()).toHaveTextContent('Deleting the test suite Microbenchmarks permanently')
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
    confirmDeletion('libcxx')

    await waitFor(() => expect(sent).toHaveLength(1))
  })

  it('checks the token again, and forgets the API keys, which may have listed it', async () => {
    signIn('manage', ['libcxx'])
    const store = mockSuites(SUITES)
    mockRuns(() => cursorPage([]))
    const { queryClient } = renderPage('/suites/libcxx?tab=schema')
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    queryClient.setQueryData(queryKeys.apiKeys, {
      items: [apiKey('manage', { suites: ['libcxx'] })],
    })
    mockDelete(store)
    // The suite is gone from the key once deleted (I5).
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage', { suites: [] }) }))

    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('leaves the suite in place of its page in the history', async () => {
    const store = await renderFromElsewhere()
    mockDelete(store)

    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
  })

  it('says that deleting may take a while, while it does', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = await startDeleting('libcxx', store)
    await act(async () => deletion.open())
  })

  it('says that no suite is left once the last is deleted', async () => {
    const { store } = await renderSuite('nts', { manage: true, suites: [BARE_SUITE] })
    mockDelete(store)
    fireEvent.click(deleteButton())

    confirmDeletion('nts')

    expect(await main().findByText('There are no test suites yet.')).toBeInTheDocument()
    expect(currentUrl()).toBe('/suites')
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
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
  })

  it('reports a suite that is not found, in the prompt, as other deletions do', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    mockDelete(store, { fail: () => errorResponse(404, 'not_found', "No suite 'libcxx'.") })
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent("No suite 'libcxx'.")
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
  })

  it('neither leaves for the suite deleted nor brings it back from a list on its way', async () => {
    const { store, queryClient } = await renderSuite('libcxx', { manage: true })
    const stale = gate()
    const refetched = mockSuites(SUITES, { wait: () => stale.promise })
    void queryClient.refetchQueries({ queryKey: queryKeys.suites })
    await waitFor(() => expect(refetched.requests).toBe(1))
    mockDelete(store)
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')
    // The suite deleted, first of the list on its way, is not the first suite left.
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    await act(async () => stale.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(cards()).toEqual(['nts', 'units'])
    expect(currentUrl()).toBe('/suites/nts')
  })

  it("leaves for /suites when the user is on another of the suite's tabs meanwhile", async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
    await act(async () => deletion.open())

    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(cards()).toEqual(['nts', 'units'])
  })

  it('leaves another suite selected meanwhile as it is, and the focus where it is', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(card('units'))
    await waitFor(() => expect(currentUrl()).toBe('/suites/units'))
    const runs = screen.getByRole('tab', { name: 'Runs' })
    runs.focus()
    await act(async () => deletion.open())

    await waitFor(() => expect(cards()).toEqual(['nts', 'units']))
    expect(currentUrl()).toBe('/suites/units')
    expect(runs).toHaveFocus()
  })

  it('forgets the suite when the user has left the page meanwhile', async () => {
    const store = await renderFromElsewhere()
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
    await act(async () => deletion.open())

    await waitFor(() => expect(store.suites.map((suite) => suite.name)).toEqual(['nts', 'units']))
    await settle()
    expect(currentUrl()).toBe('/nope')
    fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(cards()).toEqual(['nts', 'units'])
  })
})
