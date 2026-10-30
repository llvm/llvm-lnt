import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { queryKeys } from '../../api/keys'
import { schemaOf, suiteRef, type ProjectName, type Suite, type SuiteSchema } from '../../api/suites'
import { apiKey, entry, mockAuth, signIn, TOKEN } from '../../test/auth'
import { mockClipboard } from '../../test/clipboard'
import {
  BARE_SUITE,
  NO_REPOSITORY,
  PROJECT as PROJECT_LLVM,
  REF,
  SUITE,
  cursorPage,
  inProject,
} from '../../test/fixtures'
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
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import { downloadFile } from './schema/download'

vi.mock('./schema/download', () => ({ downloadFile: vi.fn() }))

/** A suite whose only metric has no unit at all. */
const UNITLESS: Suite = inProject({
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
})

const SUITES = [SUITE, BARE_SUITE, UNITLESS]

type Failure = ReturnType<typeof errorResponse>

/**
 * Answer `DELETE /api/projects/{project}/suites/{suite}` by deleting the suite from `store` once
 * `wait` resolves, or with `fail`; returns each request's project, suite, `confirm` and
 * `Authorization`.
 */
function mockDelete(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { project: string; suite: string; confirm: string | null; auth: string | null }[] =
    []
  server.use(
    mockApi('delete', '/api/projects/{project}/suites/{suite}', async ({ request, params }) => {
      sent.push({
        project: params.project,
        suite: params.suite,
        confirm: new URL(request.url).searchParams.get('confirm'),
        auth: request.headers.get('Authorization'),
      })
      await wait?.()
      if (fail) return fail()
      // Every suite of these tests is in the project 'llvm'.
      store.suites = store.suites.filter((suite) => suite.name !== params.suite)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return sent
}

/** The names of the suite picker's cards, without the links of the projects' headings. */
function cards() {
  return within(screen.getByRole('navigation', { name: 'Test suites' }))
    .getAllByRole('link')
    .filter((link) => link.closest('h2') === null)
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
  { manage = false, suites = SUITES }: { manage?: boolean; suites?: (Suite | SuiteSchema)[] } = {},
) {
  if (manage) signIn('manage')
  const store = mockSuites(suites)
  mockRuns(() => cursorPage([]))
  const rendered = renderPage(`/projects/llvm/suites/${name}?tab=schema`)
  await table('Metrics')
  if (manage) await waitFor(() => expect(deleteButton()).toBeEnabled())
  return { ...rendered, store }
}

/**
 * Show libcxx's Schema tab to a holder of a `manage` token, reached from `/projects` through its
 * card, so that Back leaves the page.
 */
async function renderFromElsewhere() {
  signIn('manage')
  const store = mockSuites(SUITES)
  mockRuns(() => cursorPage([]))
  renderPage('/projects')
  fireEvent.click(await screen.findByRole('link', { name: 'libcxx' }))
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
    renderPage('/projects/llvm/suites/libcxx?tab=schema')

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

    // The project's heading, above its suites, then the tab's.
    expect(main().getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'llvm',
      'Suite',
      'Metrics',
      'Commit Fields',
      'Machine Fields',
      'Repository',
    ])
    // The suite by its project's label, its name, and its display name, which it has none of.
    expect(screen.getByRole('group', { name: 'Suite' })).toHaveTextContent(
      'Project' + 'llvm' + 'Name' + 'libcxx' + 'Display name' + '--',
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

  it("shows the suite's project by its label, and the suite's display name", async () => {
    const project = { name: 'llvm', display_name: 'LLVM' }
    mockSuites([inProject({ ...SUITE, display_name: 'Microbenchmarks' }, project)])
    renderPage('/projects/llvm/suites/libcxx?tab=schema')

    await table('Metrics')
    expect(screen.getByRole('group', { name: 'Suite' })).toHaveTextContent(
      'Project' + 'LLVM' + 'Name' + 'libcxx' + 'Display name' + 'Microbenchmarks',
    )
  })

  it('writes -- for a metric with no unit, as for an unset display name', async () => {
    mockSuites(SUITES)
    renderPage('/projects/llvm/suites/units?tab=schema')

    expect(rowsOf(await table('Metrics'))).toEqual(['neither | datetime | -- | -- | No | No'])
  })

  it('says when a list of the schema is empty', async () => {
    mockSuites(SUITES)
    renderPage('/projects/llvm/suites/nts?tab=schema')

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
    signIn('manage', [entry('nts')])
    mockSuites(SUITES)
    renderPage(`/projects/llvm/suites/${name}?tab=schema`)
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
        "Needs an API token with the 'manage' scope in suite 'llvm/libcxx'. The token in " +
          "Settings has the 'manage' scope, covering only 'llvm/nts'.",
      ),
    )
    expect(screen.getByRole('button', { name: 'Edit schema' })).toBeDisabled()
    expect(deleteButton()).toBeDisabled()
  })
})

describe('exporting a schema', () => {
  // Without the project, which the UI adds to the schema the API returns.
  const SCHEMA = schemaOf(SUITE)
  const JSON_TEXT = JSON.stringify(SCHEMA, null, 2)

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
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(SCHEMA)
  })

  it('downloads it as a file named after the suite', async () => {
    await renderSuite('libcxx')

    fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }))

    expect(downloadFile).toHaveBeenCalledWith('libcxx.json', `${JSON_TEXT}\n`, 'application/json')
  })
})

describe('deleting a suite', () => {
  it("asks for its name, deletes it, forgets it, and leaves for its project's suites", async () => {
    const { store, queryClient } = await renderSuite('libcxx', { manage: true })
    // Something read from inside the suite, which a suite created later under its name must not
    // find.
    queryClient.setQueryData([...queryKeys.machines(REF), 'detail', 'm'], { name: 'm' })
    const sent = mockDelete(store)

    fireEvent.click(deleteButton())
    expect(deleteButton()).toHaveAttribute('aria-expanded', 'true')
    expect(prompt()).toHaveTextContent(
      'Deleting the test suite llvm/libcxx permanently destroys all of its machines, runs, ' +
        'commits, samples and regressions. This cannot be undone.',
    )
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
    confirmDeletion('libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    expect(sent).toEqual([
      { project: 'llvm', suite: 'libcxx', confirm: 'true', auth: `Bearer ${TOKEN}` },
    ])
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(cards()).toEqual(['nts', 'units'])
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.suite(REF) })).toEqual([])
  })

  it('names the suite by its label, and asks for its name (AR22, AR16)', async () => {
    const suites = [{ ...SUITE, display_name: 'Microbenchmarks' }, BARE_SUITE, UNITLESS]
    const { store } = await renderSuite('libcxx', { manage: true, suites })
    const sent = mockDelete(store)

    fireEvent.click(deleteButton())
    expect(prompt()).toHaveTextContent('Deleting the test suite llvm/Microbenchmarks permanently')
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
    confirmDeletion('libcxx')

    await waitFor(() => expect(sent).toHaveLength(1))
  })

  it('checks the token again, and forgets the API keys, which may have listed it', async () => {
    signIn('manage', [entry('libcxx')])
    const store = mockSuites(SUITES)
    mockRuns(() => cursorPage([]))
    const { queryClient } = renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(deleteButton()).toBeEnabled())
    queryClient.setQueryData(queryKeys.apiKeys, {
      items: [apiKey('manage', { restricted_to: [entry('libcxx')] })],
    })
    mockDelete(store)
    // The suite is gone from the key once deleted (I5).
    const rechecks = mockAuth(() =>
      HttpResponse.json({ key: apiKey('manage', { restricted_to: [] }) }),
    )

    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('leaves the suite in place of its page in the history', async () => {
    const store = await renderFromElsewhere()
    mockDelete(store)

    fireEvent.click(deleteButton())
    confirmDeletion('libcxx')
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects'))
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

    expect(await main().findByText('No test suites.')).toBeInTheDocument()
    expect(currentUrl()).toBe('/projects/llvm')
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
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('reports a suite that is not found, in the prompt, as other deletions do', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    mockDelete(store, { fail: () => errorResponse(404, 'not_found', "No suite 'libcxx'.") })
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent("No suite 'libcxx'.")
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('neither leaves for the suite deleted nor brings it back from a list on its way', async () => {
    const { store, queryClient } = await renderSuite('libcxx', { manage: true })
    const stale = gate()
    const refetched = mockSuites(SUITES, { wait: () => stale.promise })
    void queryClient.refetchQueries({ queryKey: queryKeys.projects })
    await waitFor(() => expect(refetched.requests).toBe(1))
    mockDelete(store)
    fireEvent.click(deleteButton())

    confirmDeletion('libcxx')
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    await act(async () => stale.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(cards()).toEqual(['nts', 'units'])
    expect(currentUrl()).toBe('/projects/llvm')
  })

  it("leaves for the project's suites when the user is on another of its tabs", async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    await act(async () => deletion.open())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    expect(cards()).toEqual(['nts', 'units'])
  })

  it('leaves another suite selected meanwhile as it is, and the focus where it is', async () => {
    const { store } = await renderSuite('libcxx', { manage: true })
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(card('units'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/units'))
    const runs = screen.getByRole('tab', { name: 'Runs' })
    runs.focus()
    await act(async () => deletion.open())

    await waitFor(() => expect(cards()).toEqual(['nts', 'units']))
    expect(currentUrl()).toBe('/projects/llvm/suites/units')
    expect(runs).toHaveFocus()
  })

  it('forgets the suite when the user has left the page meanwhile', async () => {
    const store = await renderFromElsewhere()
    const deletion = await startDeleting('libcxx', store)

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects'))
    await act(async () => deletion.open())

    await waitFor(() => expect(store.suites.map((suite) => suite.name)).toEqual(['nts', 'units']))
    await settle()
    expect(currentUrl()).toBe('/projects')
    await waitFor(() => expect(cards()).toEqual(['nts', 'units']))
  })
})

describe('renaming or moving a suite', () => {
  const SWIFT: ProjectName = { name: 'swift', display_name: 'Swift' }
  const SWIFT_SUITE = inProject({ ...BARE_SUITE, name: 'bench' }, SWIFT)

  /**
   * Answer `PATCH /api/projects/{project}/suites/{suite}` by renaming or moving the suite in `store`
   * once `wait` resolves, or with `fail`; returns each request's project, suite and body.
   */
  function mockMove(
    store: SuiteStore,
    { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
  ) {
    const sent: { project: string; suite: string; body: unknown; auth: string | null }[] = []
    server.use(
      mockApi('patch', '/api/projects/{project}/suites/{suite}', async ({ request, params }) => {
        const body = (await request.json()) as { name?: string; project?: string }
        sent.push({
          project: params.project,
          suite: params.suite,
          body,
          auth: request.headers.get('Authorization'),
        })
        await wait?.()
        if (fail) return fail()
        const index = store.suites.findIndex(
          (suite) => (suite as Suite).project.name === params.project && suite.name === params.suite,
        )
        const suite = store.suites[index] as Suite
        const project = store.projects.find((p) => p.name === (body.project ?? params.project))!
        const moved = { ...suite, name: body.name ?? suite.name, project }
        store.suites[index] = moved
        return HttpResponse.json(schemaOf(moved))
      }),
    )
    return sent
  }

  function moveButton() {
    return screen.getByRole('button', { name: 'Rename or move' })
  }

  function panel() {
    return screen.queryByRole('form', { name: 'Rename or move' })
  }

  function nameInput() {
    return within(panel()!).getByRole('textbox', { name: 'Name' })
  }

  function saveButton() {
    return within(panel()!).getByRole('button', { name: /^Save/ })
  }

  /** Libcxx's Schema tab, with SWIFT beside llvm, to a holder of `restrictedTo`'s `manage`. */
  async function renderMovable(
    restrictedTo: Parameters<typeof signIn>[1] = null,
    url = '/projects/llvm/suites/libcxx?tab=schema',
  ) {
    signIn('manage', restrictedTo)
    const store = mockSuites([...SUITES, SWIFT_SUITE], { projects: [PROJECT_LLVM, SWIFT] })
    mockRuns(() => cursorPage([]))
    const rendered = renderPage(url)
    await waitFor(() => expect(moveButton()).toBeEnabled())
    return { ...rendered, store }
  }

  /** Open the panel, and change the project to `project` and the name to `name`, unless null. */
  async function change(project: string | null, name: string | null) {
    fireEvent.click(moveButton())
    if (project !== null) await pickOption('Project', project, panel()!)
    if (name !== null) fireEvent.change(nameInput(), { target: { value: name } })
  }

  it("opens on the suite's project and name, and closes on Cancel, refocusing its button", async () => {
    await renderMovable()

    fireEvent.click(moveButton())

    expect(moveButton()).toHaveAttribute('aria-expanded', 'true')
    expect(selectButton('Project', panel()!)).toHaveTextContent('llvm')
    expect(nameInput()).toHaveValue('libcxx')
    expect(nameInput()).toHaveFocus()
    fireEvent.click(within(panel()!).getByRole('button', { name: 'Cancel' }))
    expect(panel()).not.toBeInTheDocument()
    expect(moveButton()).toHaveFocus()
  })

  it('needs manage in the suite', async () => {
    signIn('manage', [entry('nts')])
    mockSuites(SUITES)
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await table('Metrics')

    await waitFor(() =>
      expect(moveButton()).toHaveAttribute(
        'title',
        expect.stringContaining("Needs an API token with the 'manage' scope in suite"),
      ),
    )
    expect(moveButton()).toBeDisabled()
  })

  it('closes without sending anything when nothing changes', async () => {
    const { store } = await renderMovable()
    const sent = mockMove(store)
    await change('llvm', 'libcxx')

    fireEvent.click(saveButton())

    expect(panel()).not.toBeInTheDocument()
    expect(prompt()).not.toBeInTheDocument()
    expect(moveButton()).toHaveFocus()
    expect(sent).toEqual([])
  })

  it('checks the name as it is typed, against the other suites of the project picked', async () => {
    await renderMovable()
    fireEvent.click(moveButton())

    fireEvent.change(nameInput(), { target: { value: 'nts' } })
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toHaveAttribute('title', "There is already a suite named 'nts'.")
    fireEvent.change(nameInput(), { target: { value: 'Bad Name' } })
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(nameInput(), { target: { value: '' } })
    expect(saveButton()).toHaveAttribute('title', 'Give the suite a name.')
    expect(saveButton()).toBeDisabled()
    // In another project, its own name is free, and the other suites there are what count.
    fireEvent.change(nameInput(), { target: { value: 'nts' } })
    await pickOption('Project', 'Swift', panel()!)
    expect(nameInput()).not.toHaveAttribute('aria-invalid')
    fireEvent.change(nameInput(), { target: { value: 'bench' } })
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables the other projects the token does not cover in full (AR17)', async () => {
    await renderMovable([entry('libcxx')])
    fireEvent.click(moveButton())

    await userEvent.setup().click(selectButton('Project', panel()!))
    const options = await screen.findAllByRole('option')

    // Its own project, where it can be renamed, is allowed.
    expect(options[0]).toHaveAccessibleName('llvm')
    expect(options[1]).toHaveAccessibleName(
      "Swift: Needs an API token with the 'manage' scope covering project 'Swift' in full. The " +
        "token in Settings has the 'manage' scope, covering only 'llvm/libcxx'.",
    )
  })

  it('renames it once confirmed, and goes to its new Schema tab in place of the old', async () => {
    signIn('manage')
    const store = mockSuites([...SUITES, SWIFT_SUITE], { projects: [PROJECT_LLVM, SWIFT] })
    mockRuns(() => cursorPage([]))
    renderPage('/projects')
    fireEvent.click(await screen.findByRole('link', { name: 'libcxx' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Schema' }))
    await waitFor(() => expect(moveButton()).toBeEnabled())
    const sent = mockMove(store)
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent(
      'Rename the test suite llvm/libcxx to llvm/benchmarks? Every URL, bookmark and bot that ' +
        'uses the name llvm/libcxx will get a 404 until it is updated.',
    )
    expect(prompt()).toHaveTextContent('API keys are unaffected.')
    // The panel cannot change while the change is confirmed.
    expect(nameInput()).toHaveAttribute('readonly')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    expect(sent).toEqual([
      { project: 'llvm', suite: 'libcxx', body: { name: 'benchmarks' }, auth: `Bearer ${TOKEN}` },
    ])
    expect(cards()).toEqual(['benchmarks', 'nts', 'units'])
    // Once the token has been checked again, the button takes the focus back.
    await waitFor(() => expect(moveButton()).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects'))
  })

  it("moves it, saying what that means for the API keys, by the projects' labels", async () => {
    const { store } = await renderMovable()
    const sent = mockMove(store)
    await change('Swift', null)

    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent(
      'Move the test suite llvm/libcxx to swift/libcxx? Every URL, bookmark and bot that uses ' +
        'the name llvm/libcxx will get a 404 until it is updated.',
    )
    expect(prompt()).toHaveTextContent(
      "API keys listing the project 'llvm' as a whole will no longer cover the suite, those " +
        "listing the project 'Swift' as a whole will, and those listing the suite itself still " +
        'will.',
    )
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/libcxx?tab=schema'))
    expect(sent.map(({ body }) => body)).toEqual([{ project: 'swift' }])
    expect(cards()).toEqual(['bench', 'libcxx'])
  })

  it('never shows the old names as not found on the way', async () => {
    const { store } = await renderMovable()
    mockMove(store)
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(document.body.textContent ?? ''))
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    await waitFor(() => expect(moveButton()).toHaveFocus())
    observer.disconnect()

    expect(seen.filter((text) => text.includes('not found'))).toEqual([])
  })

  it('forgets what was read under both names, and the API keys, and checks the token', async () => {
    const { store, queryClient } = await renderMovable()
    const to = suiteRef('swift', 'libcxx')
    // Something read from inside the suite under its old names, which a suite created later
    // under them must not find, and from inside an earlier suite of the new names.
    queryClient.setQueryData([...queryKeys.machines(REF), 'detail', 'm'], { name: 'm' })
    queryClient.setQueryData([...queryKeys.machines(to), 'detail', 'm'], { name: 'old' })
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    mockMove(store)
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))
    await change('Swift', null)

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/libcxx?tab=schema'))
    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    await settle()
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.suite(REF) })).toEqual([])
    expect(queryClient.getQueryData([...queryKeys.machines(to), 'detail', 'm'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('shows why the change failed, in the panel, which can then be changed again', async () => {
    const { store } = await renderMovable()
    mockMove(store, { fail: () => errorResponse(409, 'duplicate', 'Taken meanwhile.') })
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Taken meanwhile.')
    expect(prompt()).not.toBeInTheDocument()
    expect(nameInput()).toHaveValue('benchmarks')
    expect(nameInput()).not.toHaveAttribute('readonly')
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('goes back to the panel, sending nothing, when the prompt is cancelled', async () => {
    const { store } = await renderMovable()
    const sent = mockMove(store)
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(nameInput()).toHaveFocus()
    expect(nameInput()).toHaveValue('benchmarks')
    expect(sent).toEqual([])
  })

  it('goes to the new Schema tab when the user is on another of its tabs', async () => {
    const { store } = await renderMovable()
    const held = gate()
    mockMove(store, { wait: () => held.promise })
    await change(null, 'benchmarks')
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    await act(async () => held.open())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
  })

  it('stays where the user went, if they have left the page meanwhile', async () => {
    const { store } = await renderMovable()
    const held = gate()
    mockMove(store, { wait: () => held.promise })
    await change(null, 'benchmarks')
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    fireEvent.click(card('units'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/units'))
    await act(async () => held.open())

    await waitFor(() => expect(cards()).toEqual(['benchmarks', 'nts', 'units']))
    await settle()
    expect(currentUrl()).toBe('/projects/llvm/suites/units')
  })
})
