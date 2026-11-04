import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, onTestFinished } from 'vitest'
import { queryKeys } from '../../../api/keys'
import { suiteRef, type ProjectName, type Suite, type SuiteSchema } from '../../../api/suites'
import { TOKEN_STORAGE_KEY } from '../../../auth/storage-key'
import {
  apiKey,
  changeInAnotherTab,
  entry,
  mockAuth,
  signIn,
  TOKEN,
  unknownToken,
} from '../../../test/auth'
import { BARE_SUITE, PROJECT, REF, SUITE, cursorPage, inProject } from '../../../test/fixtures'
import { answerLeaving, unloadAsks } from '../../../test/leave'
import { errorResponse, mockApi } from '../../../test/mock-api'
import {
  chipLink,
  chipTexts,
  currentUrl,
  gate,
  main,
  mockMachines,
  mockRuns,
  mockSuites,
  navbarLink,
  renderPage,
  renderPageFrom,
  rowsOf,
  settle,
  table,
  typeInto,
  type SuiteStore,
} from '../../../test/page'
import { pickOption, selectButton } from '../../../test/select'
import { server } from '../../../test/server'

// The machines of a suite whose Runs tab a test ends up on, which name runs' machines (AR23).
beforeEach(() => {
  mockMachines(() => ({ items: [] }))
})

type Failure = ReturnType<typeof errorResponse>

/** SUITE as it is stored now, changed since the list of suites was fetched. */
const FRESH: Suite = {
  ...SUITE,
  metrics: [...SUITE.metrics, { ...SUITE.metrics[0], name: 'code_size', display_name: 'Size' }],
}

/** `suite`, as the API returns it: without the project the UI adds. */
function schemaOf(suite: Suite | SuiteSchema): SuiteSchema {
  const { project, ...schema } = suite as Suite
  void project
  return schema
}

/** The suite named `name` that `store` holds in the project 'llvm', which holds them all. */
function stored(store: SuiteStore, project: string, name: string) {
  return project === PROJECT.name ? store.suites.find((suite) => suite.name === name) : undefined
}

/**
 * Answer `GET /api/projects/{project}/suites/{suite}` with the suite as `store` holds it, once
 * `wait` resolves, or with `fail`; returns how many times it was asked.
 */
function mockFresh(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const requests = { count: 0 }
  server.use(
    mockApi('get', '/api/projects/{project}/suites/{suite}', async ({ params }) => {
      requests.count++
      await wait?.()
      if (fail) return fail()
      const schema = stored(store, params.project, params.suite)
      if (!schema) return errorResponse(404, 'not_found', `No suite '${params.suite}'`)
      return HttpResponse.json(schemaOf(schema))
    }),
  )
  return requests
}

/**
 * Answer `PATCH /api/projects/{project}/suites/{suite}/schema` with `respond`'s schema, which
 * replaces the suite in `store`, once `wait` resolves, or with `fail`; returns each request's body
 * and `confirm`.
 */
function mockPatch(
  store: SuiteStore,
  respond: (schema: Suite | SuiteSchema) => Suite | SuiteSchema,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { body: unknown; confirm: string | null }[] = []
  server.use(
    mockApi(
      'patch',
      '/api/projects/{project}/suites/{suite}/schema',
      async ({ request, params }) => {
        sent.push({
          body: await request.json(),
          confirm: new URL(request.url).searchParams.get('confirm'),
        })
        await wait?.()
        if (fail) return fail()
        const schema = respond(stored(store, params.project, params.suite)!)
        store.suites = store.suites.map((suite) => (suite.name === schema.name ? schema : suite))
        return HttpResponse.json(schemaOf(schema))
      },
    ),
  )
  return sent
}

function editButton() {
  return screen.getByRole('button', { name: 'Edit schema' })
}

function editor() {
  return screen.queryByRole('region', { name: 'Editing llvm › libcxx' })
}

/** The editor's Save, rather than the one of the prompt confirming a removal. */
function saveButton() {
  return within(editor()!).getAllByRole('button', { name: /^(Save|Saving\.\.\.)$/ })[0]
}

function prompt() {
  return screen.queryByRole('form', { name: 'Confirmation' })
}

/**
 * Show libcxx's Schema tab to a holder of a `manage` token, whose list of suites holds
 * SUITE but whose server holds FRESH, and open the editor on it; reached through a link from the
 * page at `from`, if given, so that Back leads there.
 */
async function openEditor(from?: string) {
  signIn('manage')
  const store = mockSuites([SUITE, BARE_SUITE])
  const fresh = mockFresh({ ...store, suites: [FRESH, BARE_SUITE] })
  const url = '/projects/llvm/suites/libcxx?tab=schema'
  const { queryClient } = from === undefined ? renderPage(url) : await renderPageFrom(from, url)
  await waitFor(() => expect(editButton()).toBeEnabled())
  fireEvent.click(editButton())
  await screen.findByRole('textbox', { name: 'Display name of metric code_size' })
  store.suites = [FRESH, BARE_SUITE]
  return Object.assign(store, { queryClient, fresh })
}

describe('opening the editor on a suite', () => {
  it('needs the manage scope', async () => {
    signIn('submit')
    mockSuites()
    renderPage('/projects/llvm/suites/libcxx?tab=schema')

    await table('Metrics')
    await waitFor(() =>
      expect(editButton()).toHaveAccessibleDescription(expect.stringContaining("'manage' scope")),
    )
    expect(editButton()).toBeDisabled()
  })

  it('starts from the schema as it is now, fetched each time it opens', async () => {
    const store = await openEditor()

    expect(store.fresh.count).toBe(1)
    expect(screen.queryByRole('button', { name: 'Delete This Suite' })).not.toBeInTheDocument()
    // An existing entry's name and type are shown, not edited.
    expect(rowsOf(await table('Metrics'))[1]).toMatch(/^code_size \| real \| /)
    expect(screen.queryByRole('textbox', { name: /^Name of metric/ })).not.toBeInTheDocument()

    fireEvent.click(within(editor()!).getByRole('button', { name: 'Cancel' }))
    expect(editor()).not.toBeInTheDocument()
    expect(editButton()).toHaveFocus()
    fireEvent.click(editButton())
    await waitFor(() => expect(store.fresh.count).toBe(2))
  })

  it('says it is loading, and why it failed, with a way to try again or cancel', async () => {
    signIn('manage')
    const store = mockSuites([SUITE, BARE_SUITE])
    const reply = gate()
    mockFresh(store, {
      wait: () => reply.promise,
      fail: () => errorResponse(500, 'internal_error', 'The database is down.'),
    })
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())

    expect(await within(editor()!).findByText('Loading the schema...')).toBeInTheDocument()
    await act(async () => reply.open())
    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('The database is down.')

    mockFresh(store)
    fireEvent.click(within(editor()!).getByRole('button', { name: 'Retry' }))
    expect(
      await screen.findByRole('textbox', { name: 'Display name of metric execution_time' }),
    ).toBeInTheDocument()
  })

  it('closes, and drops the suite, when the suite is gone', async () => {
    signIn('manage')
    const store = mockSuites([SUITE, BARE_SUITE])
    mockFresh({ ...store, suites: [BARE_SUITE] })
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    store.suites = [BARE_SUITE]

    fireEvent.click(editButton())

    expect(await main().findByRole('alert')).toHaveTextContent(
      "Test suite 'llvm/libcxx' not found.",
    )
    expect(editor()).not.toBeInTheDocument()
    expect(main().queryByRole('link', { name: 'libcxx' })).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })
})

describe('leaving the tab', () => {
  const CODE_SIZE = { name: 'Display name of metric code_size' }

  function codeSize() {
    return screen.getByRole('textbox', CODE_SIZE)
  }

  /** Open the editor on libcxx (see `openEditor`), and change it, the Runs tab listing no runs. */
  async function openChanged(from?: string) {
    mockRuns(() => cursorPage([]))
    const store = await openEditor(from)
    typeInto(codeSize(), 'Changed')
    return store
  }

  /** Whether the Schema tab shows the viewer, rather than the editor and its changes. */
  async function expectViewer() {
    expect(await table('Metrics')).toBeInTheDocument()
    expect(editor()).not.toBeInTheDocument()
    expect(screen.queryByDisplayValue('Changed')).not.toBeInTheDocument()
  }

  /** Whether the editor is still open on the Schema tab, with its changes. */
  function expectEditor() {
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
    expect(codeSize()).toHaveValue('Changed')
  }

  it('to another tab asks first, staying if the user says so', async () => {
    await openChanged()
    const confirm = answerLeaving(false)

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(confirm).toHaveBeenCalledOnce()
    expectEditor()

    // The tab refused can be asked for again, and asks again.
    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(confirm).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))

    await expectViewer()
  })

  it('asks once per click on a tab, and not again until the user tries to leave again', async () => {
    await openChanged()
    const confirm = answerLeaving(false)
    const user = userEvent.setup()
    const runs = screen.getByRole('tab', { name: 'Runs' })
    const machines = screen.getByRole('tab', { name: 'Machines' })

    // The pointer leaving the tab and coming back, pressed or not, or the window getting the
    // focus back once the user has answered, asks nothing more.
    await user.pointer({ keys: '[MouseLeft>]', target: runs })
    await user.pointer({ target: machines })
    await user.pointer({ target: runs })
    await user.pointer({ keys: '[/MouseLeft]', target: runs })
    expect(confirm).toHaveBeenCalledOnce()
    act(() => void window.dispatchEvent(new FocusEvent('focus')))
    await user.pointer({ target: machines })
    await user.pointer({ target: runs })
    await settle()

    expect(confirm).toHaveBeenCalledOnce()
    expectEditor()
  })

  it('to another suite by its chip asks first, keeping the tab (TS1)', async () => {
    await openChanged()
    const confirm = answerLeaving(false)

    fireEvent.click(chipLink('Test suites', 'nts'))
    expect(confirm).toHaveBeenCalledOnce()
    // Staying leaves the URL as it was, with the editor (AR19).
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
    expectEditor()

    confirm.mockReturnValue(true)
    fireEvent.click(chipLink('Test suites', 'nts'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=schema'))
    expect(confirm).toHaveBeenCalledTimes(2)
  })

  it('by Back or Forward asks first', async () => {
    function browser(button: 'back' | 'forward') {
      fireEvent.click(screen.getByRole('button', { name: `Browser ${button}` }))
    }

    await openChanged('/projects/llvm/suites/nts?tab=schema')
    const confirm = answerLeaving(false)
    browser('back')
    expect(confirm).toHaveBeenCalledOnce()
    expectEditor()
    confirm.mockReturnValue(true)
    browser('back')
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=schema'))
    expect(confirm).toHaveBeenCalledTimes(2)

    // The editor opened on nts, and changed, asks before Forward.
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    typeInto(await screen.findByRole('textbox', { name: 'Display name' }), 'Changed')
    confirm.mockReturnValue(false)
    browser('forward')
    expect(confirm).toHaveBeenCalledTimes(3)
    expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=schema')
    confirm.mockReturnValue(true)
    browser('forward')
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema'))
    expect(confirm).toHaveBeenCalledTimes(4)

    await expectViewer()
  })

  it("by the navbar asks first, and the suite's own chip goes nowhere", async () => {
    await openChanged()
    const confirm = answerLeaving(false)

    fireEvent.click(chipLink('Test suites', 'libcxx'))
    expect(confirm).not.toHaveBeenCalled()
    fireEvent.click(navbarLink('Graph'))
    expect(confirm).toHaveBeenCalledOnce()
    expectEditor()

    confirm.mockReturnValue(true)
    fireEvent.click(navbarLink('Projects'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(editor()).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))

    await expectViewer()
  })

  it('has the browser ask before a reload, only while changed', async () => {
    await openEditor()
    expect(unloadAsks()).toBe(false)

    typeInto(codeSize(), 'Changed')
    expect(unloadAsks()).toBe(true)
    // Changed back: Save would send nothing.
    typeInto(codeSize(), 'Size')
    expect(unloadAsks()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))
    expect(unloadAsks()).toBe(true)
  })

  it('has the browser ask before a reload once the repository changed', async () => {
    await openEditor()
    const label = screen.getByRole('textbox', { name: 'Label' })

    typeInto(label, 'GitLab')
    expect(unloadAsks()).toBe(true)
    typeInto(label, ' GitHub ')
    expect(unloadAsks()).toBe(false)
  })

  it('asks nothing without changes, or once they are undone', async () => {
    mockRuns(() => cursorPage([]))
    await openEditor()
    const confirm = answerLeaving(false)
    typeInto(codeSize(), 'Changed')
    typeInto(codeSize(), ' Size ')

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks first with an entry added, even without a name', async () => {
    await openEditor()
    const confirm = answerLeaving(false)
    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    expect(confirm).toHaveBeenCalledOnce()
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('asks nothing once the changes are discarded by Cancel, or saved', async () => {
    const store = await openChanged()
    const confirm = answerLeaving(false)

    fireEvent.click(within(editor()!).getByRole('button', { name: 'Cancel' }))
    expect(unloadAsks()).toBe(false)
    fireEvent.click(editButton())
    typeInto(await screen.findByRole('textbox', CODE_SIZE), 'Changed')
    mockPatch(store, (schema) => schema)
    fireEvent.click(saveButton())
    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(unloadAsks()).toBe(false)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(confirm).not.toHaveBeenCalled()
  })
})

describe('editing', () => {
  it('removes an existing entry only once saved, until which it can be undone', async () => {
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))

    const undo = screen.getByRole('button', { name: 'Undo removing metric code_size' })
    expect(undo).toHaveFocus()
    expect(rowsOf(await table('Metrics'))[1]).toMatch(/^code_size \| real \| \(removed\)/)
    expect(
      screen.queryByRole('textbox', { name: 'Display name of metric code_size' }),
    ).not.toBeInTheDocument()

    fireEvent.click(undo)
    expect(screen.getByRole('button', { name: 'Remove metric code_size' })).toHaveFocus()
    expect(screen.getByRole('textbox', { name: 'Display name of metric code_size' })).toHaveValue(
      'Size',
    )
  })

  it("keeps a removed entry's name taken until saved", async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))

    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))
    typeInto(screen.getByRole('textbox', { name: 'Name of metric 3' }), 'code_size')

    expect(screen.getByRole('textbox', { name: 'Name of metric 3' })).toHaveAccessibleDescription(
      "The metric 'code_size' is removed in this edit, so it cannot be added again until the " +
        'edit is saved.',
    )
    expect(saveButton()).toBeDisabled()
    expect(saveButton()).toHaveAccessibleDescription('Correct the names marked in red first.')
  })
})

describe('the repository', () => {
  it('starts as stored, its URLs checked only once changed', async () => {
    // Stored by a server that accepted it, which this editor would not.
    const odd = { ...SUITE.repository, commit_url: 'https://{commit}' }
    signIn('manage')
    const store = mockSuites([{ ...SUITE, repository: odd }])
    mockFresh(store)
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    const url = await screen.findByRole('textbox', { name: 'Commit URL' })

    expect(url).toHaveValue('https://{commit}')
    expect(url).not.toHaveAttribute('aria-invalid')
    expect(saveButton()).toBeEnabled()

    typeInto(url, 'https://{commit}/')
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toHaveAccessibleDescription(
      'Correct the repository URLs marked in red first.',
    )
  })

  it('sends only the keys changed, then shows the repository saved', async () => {
    const store = await openEditor()
    const sent = mockPatch(store, (schema) => ({
      ...schema,
      repository: { ...schema.repository, label: null, range_url: 'https://example.com/{from}/{to}' },
    }))

    typeInto(screen.getByRole('textbox', { name: 'Label' }), '  ')
    typeInto(screen.getByRole('textbox', { name: 'Range URL' }), 'https://example.com/{from}/{to}')
    fireEvent.click(saveButton())

    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toEqual([
      {
        body: { repository: { label: null, range_url: 'https://example.com/{from}/{to}' } },
        confirm: null,
      },
    ])
    expect(screen.getByRole('group', { name: 'Repository' })).toHaveTextContent(
      `Label--Commit URL${SUITE.repository.commit_url}Range URLhttps://example.com/{from}/{to}`,
    )
  })
})

describe("the suite's display name", () => {
  function displayNameInput() {
    return within(editor()!).getByRole('textbox', { name: 'Display name' })
  }

  it('starts as stored, and is sent alone once changed, then shown saved', async () => {
    const store = await openEditor()
    expect(displayNameInput()).toHaveValue('')
    const sent = mockPatch(store, (schema) => ({ ...schema, display_name: 'Microbenchmarks' }))

    typeInto(displayNameInput(), ' Microbenchmarks ')
    expect(unloadAsks()).toBe(true)
    fireEvent.click(saveButton())

    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toEqual([{ body: { display_name: 'Microbenchmarks' }, confirm: null }])
    expect(screen.getByRole('group', { name: 'Suite' })).toHaveTextContent(
      'ProjectllvmNamelibcxxDisplay nameMicrobenchmarks',
    )
  })

  it('is cleared by emptying it, and left alone when only its spaces change', async () => {
    signIn('manage')
    const named = { ...SUITE, display_name: 'Micro' }
    const store = mockSuites([named, BARE_SUITE])
    mockFresh(store)
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    const input = await screen.findByRole('textbox', { name: 'Display name' })
    // Named by the suite's label (AR22).
    const region = screen.getByRole('region', { name: 'Editing llvm › Micro' })
    expect(input).toHaveValue('Micro')
    const sent = mockPatch(store, (schema) => ({ ...schema, display_name: null }))

    typeInto(input, ' Micro ')
    expect(unloadAsks()).toBe(false)
    typeInto(input, '  ')
    fireEvent.click(within(region).getAllByRole('button', { name: 'Save' })[0])

    await waitFor(() => expect(region).not.toBeInTheDocument())
    expect(sent).toEqual([{ body: { display_name: null }, confirm: null }])
  })
})

describe('saving', () => {
  it('sends only what changed, then shows the schema saved', async () => {
    const store = await openEditor()
    const sent = mockPatch(store, (schema) => ({
      ...schema,
      metrics: schema.metrics.map((metric) =>
        metric.name === 'code_size'
          ? { ...metric, display_name: 'Code size', dashboard: false }
          : metric,
      ),
      machine_fields: [
        ...schema.machine_fields.map((field) =>
          field.name === 'hardware' ? { ...field, listed: false } : field,
        ),
        { name: 'kernel', type: 'text', display_name: null, searchable: false, listed: false },
      ],
    }))
    // Read from inside the suite, before its schema changed.
    store.queryClient.setQueryData([...queryKeys.machines(REF), 'list'], { items: [] })

    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Code size')
    fireEvent.click(screen.getByRole('checkbox', { name: 'On the Dashboard of metric code_size' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Listed of machine field hardware' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add machine field' }))
    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 4' }), 'kernel')
    fireEvent.click(saveButton())

    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toEqual([
      {
        body: {
          metrics: {
            update: [{ name: 'code_size', display_name: 'Code size', dashboard: false }],
          },
          machine_fields: {
            add: [
              {
                name: 'kernel',
                type: 'text',
                display_name: null,
                searchable: false,
                listed: false,
              },
            ],
            update: [{ name: 'hardware', listed: false }],
          },
        },
        confirm: null,
      },
    ])
    expect(rowsOf(await table('Metrics'))[1]).toBe(
      'code_size | real | Code size | seconds (s) | No | No',
    )
    expect(rowsOf(await table('Machine fields'))).toEqual([
      'hardware | text | Hardware | Yes | No',
      'os | text | -- | Yes | No',
      'core_count | integer | Cores | No | Yes',
      'kernel | text | -- | No | No',
    ])
    expect(editButton()).toHaveFocus()
    expect(
      store.queryClient.getQueryData([...queryKeys.machines(REF), 'list']),
    ).toBeUndefined()
  })

  it('closes without sending anything when nothing changed', async () => {
    const store = await openEditor()
    const sent = mockPatch(store, (schema) => schema)

    // Changed, then changed back.
    const input = screen.getByRole('textbox', { name: 'Display name of metric code_size' })
    typeInto(input, 'Other')
    typeInto(input, 'Size')
    fireEvent.click(saveButton())

    expect(editor()).not.toBeInTheDocument()
    expect(sent).toEqual([])
  })

  it('has the user confirm a removal by typing the suite name', async () => {
    const store = await openEditor()
    const sent = mockPatch(store, (schema) => ({
      ...schema,
      metrics: schema.metrics.filter((metric) => metric.name !== 'code_size'),
      machine_fields: schema.machine_fields.filter((field) => field.name !== 'os'),
    }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove machine field os' }))

    fireEvent.click(saveButton())

    expect(sent).toEqual([])
    expect(saveButton()).toHaveAttribute('aria-expanded', 'true')
    const confirmation = prompt()!
    expect(
      within(confirmation)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['metric code_size', 'machine field os'])
    expect(confirmation).toHaveTextContent('along with the regression indicators')
    const confirm = within(confirmation).getByRole('button', { name: 'Save' })
    expect(confirm).toBeDisabled()

    typeInto(within(confirmation).getByRole('textbox'), 'libcxx')
    fireEvent.click(confirm)

    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toEqual([
      {
        body: { metrics: { remove: ['code_size'] }, machine_fields: { remove: ['os'] } },
        confirm: 'true',
      },
    ])
    expect(rowsOf(await table('Metrics'))).toHaveLength(1)
  })

  it('names the suite by its label in the prompt, which asks for its name (AR22, AR16)', async () => {
    signIn('manage')
    const named = { ...SUITE, display_name: 'Micro' }
    mockFresh(mockSuites([named, BARE_SUITE]))
    renderPage('/projects/llvm/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Remove metric execution_time' }))

    const region = screen.getByRole('region', { name: 'Editing llvm › Micro' })
    fireEvent.click(within(region).getAllByRole('button', { name: 'Save' })[0])

    expect(prompt()).toHaveTextContent('Saving removes these entries from the suite llvm › Micro:')
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
  })

  it('changes nothing in the editor while the removal is being confirmed', async () => {
    await openEditor()
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))
    fireEvent.click(saveButton())

    fireEvent.click(screen.getByRole('button', { name: 'Undo removing metric code_size' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))
    expect(
      screen.getByRole('textbox', { name: 'Display name of metric execution_time' }),
    ).toHaveAttribute('readonly')
    expect(prompt()).toBeInTheDocument()
    expect(rowsOf(await table('Metrics'))).toHaveLength(2)

    // Cancelling gives the editor back, and the focus to Save.
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))
    expect(prompt()).not.toBeInTheDocument()
    expect(saveButton()).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Undo removing metric code_size' }))
    expect(screen.getByRole('button', { name: 'Remove metric code_size' })).toBeInTheDocument()
  })

  it('shows no failure of an earlier save beside the prompt', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(400, 'invalid_request', 'Bad display name.'),
    })
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Odd')
    fireEvent.click(saveButton())
    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('Bad display name.')

    fireEvent.click(screen.getByRole('button', { name: 'Remove metric execution_time' }))
    fireEvent.click(saveButton())

    expect(prompt()).toBeInTheDocument()
    expect(within(editor()!).queryByRole('alert')).not.toBeInTheDocument()
  })

  it('keeps the editor as it was when a confirmed save fails, saying why', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(409, 'retry', 'The schema changed meanwhile; try again.'),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))
    fireEvent.click(saveButton())
    typeInto(within(prompt()!).getByRole('textbox'), 'libcxx')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent(
      'The schema changed meanwhile',
    )
    expect(
      screen.getByRole('button', { name: 'Undo removing metric code_size' }),
    ).toBeInTheDocument()
  })

  it('keeps the editor as it was when a save fails, with the reason', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(400, 'invalid_request', 'Bad display name.'),
    })
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Odd')

    fireEvent.click(saveButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('Bad display name.')
    expect(screen.getByRole('textbox', { name: 'Display name of metric code_size' })).toHaveValue(
      'Odd',
    )
  })

  it('closes, and drops the suite, when the suite was deleted meanwhile', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => {
        store.suites = [BARE_SUITE]
        return errorResponse(404, 'not_found', "No suite 'libcxx'")
      },
    })
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Odd')

    saveButton().focus()
    fireEvent.click(saveButton())

    // The page says so in place of the editor, and takes the focus the editor had.
    const notFound = await main().findByText("Test suite 'llvm/libcxx' not found.")
    expect(editor()).not.toBeInTheDocument()
    expect(notFound).toHaveFocus()
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('leaves the focus where it is, if elsewhere, once the suite turns out deleted', async () => {
    const store = await openEditor()
    const reply = gate()
    mockPatch(store, (schema) => schema, {
      wait: () => reply.promise,
      fail: () => {
        store.suites = [BARE_SUITE]
        return errorResponse(404, 'not_found', "No suite 'libcxx'")
      },
    })
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Odd')
    fireEvent.click(saveButton())
    const chip = chipLink('Test suites', 'nts')
    chip.focus()

    await act(async () => reply.open())

    expect(await main().findByText("Test suite 'llvm/libcxx' not found.")).not.toHaveFocus()
    expect(chip).toHaveFocus()
  })

  it('has the list of suites fetched again when an entry was added meanwhile', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(409, 'duplicate', "A machine field 'kernel' already exists"),
    })
    const before = store.requests
    fireEvent.click(screen.getByRole('button', { name: '+ Add machine field' }))
    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 4' }), 'kernel')

    fireEvent.click(saveButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('already exists')
    await waitFor(() => expect(store.requests).toBe(before + 1))
    expect(editor()).toBeInTheDocument()
  })

  it('stays open, with the page, when the list fetched again fails', async () => {
    const store = await openEditor()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(409, 'duplicate', "A machine field 'kernel' already exists"),
    })
    const lists = { count: 0 }
    server.use(
      mockApi('get', '/api/projects', () => {
        lists.count++
        return errorResponse(500, 'internal_error', 'The database is down.')
      }),
    )
    fireEvent.click(screen.getByRole('button', { name: '+ Add machine field' }))
    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 4' }), 'kernel')

    fireEvent.click(saveButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('already exists')
    await waitFor(() => expect(lists.count).toBe(1))
    await waitFor(() => expect(store.queryClient.isFetching()).toBe(0))
    expect(editor()).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name of machine field 4' })).toHaveValue('kernel')
    expect(main().getByRole('link', { name: 'nts' })).toBeInTheDocument()
    expect(screen.queryByText('The database is down.')).not.toBeInTheDocument()
  })

  it('changes nothing while it is under way, keeping the focus', async () => {
    const store = await openEditor()
    const reply = gate()
    mockPatch(store, (schema) => schema, { wait: () => reply.promise })
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Odd')

    saveButton().focus()
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveButton()).toHaveTextContent('Saving...'))
    expect(saveButton()).toHaveFocus()
    expect(saveButton()).toHaveAttribute('aria-disabled', 'true')
    expect(
      screen.getByRole('textbox', { name: 'Display name of metric code_size' }),
    ).toHaveAttribute('readonly')
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric code_size' }))
    fireEvent.click(within(editor()!).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('button', { name: /^Undo/ })).not.toBeInTheDocument()
    expect(editor()).toBeInTheDocument()

    await act(async () => reply.open())
    await waitFor(() => expect(editor()).not.toBeInTheDocument())
  })

  it('updates the list of suites even if the user has left the tab meanwhile', async () => {
    const store = await openEditor()
    const reply = gate()
    mockPatch(
      store,
      (schema) => ({
        ...schema,
        metrics: schema.metrics.map((metric) => ({ ...metric, display_name: 'Changed' })),
      }),
      { wait: () => reply.promise },
    )
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Changed')
    fireEvent.click(saveButton())
    await waitFor(() => expect(saveButton()).toHaveTextContent('Saving...'))

    // Still unsaved: the user is asked first, and leaving does not cancel the save.
    const confirm = answerLeaving(true)
    mockRuns(() => cursorPage([]))
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => reply.open())
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))

    await waitFor(async () =>
      expect(rowsOf(await table('Metrics'))[1]).toMatch(/^code_size \| real \| Changed/),
    )
    expect(editor()).not.toBeInTheDocument()
  })
})

describe('renaming or moving the suite', () => {
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

  /** The order in which the schema and the suite were changed. */
  function recordOrder() {
    const order: string[] = []
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'PATCH') order.push(new URL(request.url).pathname)
    })
    onTestFinished(() => server.events.removeAllListeners())
    return order
  }

  function suiteBox() {
    return within(editor()!).getByRole('group', { name: 'Suite' })
  }

  function nameInput() {
    return within(suiteBox()).getByRole('textbox', { name: 'Name' })
  }

  /**
   * Open the editor on libcxx, with SWIFT beside llvm, to a holder of `restrictedTo`'s `manage`;
   * reached through a link from the page at `from`, if given, so that Back leads there.
   */
  async function openMovable(
    restrictedTo: Parameters<typeof signIn>[1] = null,
    { from }: { from?: string } = {},
  ) {
    signIn('manage', restrictedTo)
    const store = mockSuites([SUITE, BARE_SUITE, SWIFT_SUITE], { projects: [PROJECT, SWIFT] })
    mockFresh(store)
    mockRuns(() => cursorPage([]))
    const url = '/projects/llvm/suites/libcxx?tab=schema'
    const rendered = from === undefined ? renderPage(url) : await renderPageFrom(from, url)
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    await within(await screen.findByRole('group', { name: 'Suite' })).findByRole('textbox', {
      name: 'Name',
    })
    return { ...rendered, store }
  }

  /** Change the project to `project` and the name to `name`, unless null. */
  async function change(project: string | null, name: string | null) {
    if (project !== null) await pickOption('Project', project, suiteBox())
    if (name !== null) typeInto(nameInput(), name)
  }

  /** Save, and confirm the plain prompt, which asks for nothing to be typed. */
  function saveConfirmed() {
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))
  }

  it("shows the suite's project, name and display name, laid out as the viewer shows them", async () => {
    await openMovable()

    expect(selectButton('Project', suiteBox())).toHaveTextContent('llvm')
    expect(nameInput()).toHaveValue('libcxx')
    expect(within(suiteBox()).getByRole('textbox', { name: 'Display name' })).toHaveValue('')
    // Above the entries, as in the viewer.
    expect(
      suiteBox().compareDocumentPosition(screen.getByRole('table', { name: 'Metrics' })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('closes without sending anything when the name and project are changed back', async () => {
    const { store } = await openMovable()
    const sent = mockMove(store)
    await change('Swift', 'other')
    await change('llvm', 'libcxx')

    fireEvent.click(saveButton())

    expect(editor()).not.toBeInTheDocument()
    expect(prompt()).not.toBeInTheDocument()
    expect(sent).toEqual([])
  })

  it('checks the name as it is typed, against the other suites of the project picked', async () => {
    await openMovable()

    typeInto(nameInput(), 'nts')
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton()).toHaveAttribute('title', "There is already a suite named 'nts'.")
    typeInto(nameInput(), 'Bad Name')
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    typeInto(nameInput(), '')
    expect(saveButton()).toHaveAttribute('title', 'Give the suite a name.')
    expect(saveButton()).toBeDisabled()
    // In another project, its own name is free, and the other suites there are what count.
    typeInto(nameInput(), 'nts')
    await pickOption('Project', 'Swift', suiteBox())
    expect(nameInput()).not.toHaveAttribute('aria-invalid')
    typeInto(nameInput(), 'bench')
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
  })

  it('disables the other projects the token does not cover in full (AR17)', async () => {
    await openMovable([entry('libcxx')])

    await userEvent.setup().click(selectButton('Project', suiteBox()))
    const options = await screen.findAllByRole('option')

    // Its own project, where it can be renamed, is allowed.
    expect(options[0]).toHaveAccessibleName('llvm')
    expect(options[0]).not.toHaveAttribute('aria-disabled')
    expect(options[1]).toHaveAccessibleName(
      "Swift: Needs an API token with the 'manage' scope covering project 'Swift' in full. The " +
        "token in Settings has the 'manage' scope, covering only 'llvm › libcxx'.",
    )
    expect(options[1]).toHaveAttribute('aria-disabled', 'true')
  })

  it('asks before the editor is left with a new name or project', async () => {
    await openMovable()
    const confirm = answerLeaving(false)

    typeInto(nameInput(), 'benchmarks')
    expect(unloadAsks()).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(confirm).toHaveBeenCalledOnce()

    typeInto(nameInput(), 'libcxx')
    await change('Swift', null)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('renames it once confirmed, and goes to its new Schema tab in place of the old', async () => {
    const { store } = await openMovable(null, { from: '/projects/llvm/suites/nts' })
    const sent = mockMove(store)
    const confirm = answerLeaving(false)
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent(
      'Rename the test suite llvm/libcxx to llvm/benchmarks? Every URL, bookmark and bot that ' +
        'uses the name llvm/libcxx will get a 404 until it is updated.',
    )
    expect(prompt()).toHaveTextContent('API keys are unaffected.')
    // A plain confirmation, since nothing is destroyed (AR16).
    expect(within(prompt()!).queryByRole('textbox')).not.toBeInTheDocument()
    // The editor cannot change while the change is confirmed.
    expect(nameInput()).toHaveAttribute('readonly')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    expect(sent).toEqual([
      { project: 'llvm', suite: 'libcxx', body: { name: 'benchmarks' }, auth: `Bearer ${TOKEN}` },
    ])
    // The editor's own navigation, which asks nothing.
    expect(confirm).not.toHaveBeenCalled()
    expect(editor()).not.toBeInTheDocument()
    expect(chipTexts('Test suites')).toEqual(['benchmarks', 'nts'])
    // Once the token has been checked again, "Edit schema" takes the focus, as once the editor
    // has closed.
    await waitFor(() => expect(editButton()).toHaveFocus())
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts'))
  })

  it("moves it, saying what that means for the API keys, by the projects' labels", async () => {
    const { store } = await openMovable()
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
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/libcxx?tab=schema'))
    expect(sent.map(({ body }) => body)).toEqual([{ project: 'swift' }])
    expect(chipTexts('Test suites')).toEqual(['bench', 'libcxx'])
  })

  it('changes the schema first, under the old names, then renames it, in one prompt', async () => {
    const { store } = await openMovable()
    const order = recordOrder()
    const patched = mockPatch(store, (schema) => ({
      ...schema,
      display_name: 'Bench',
      metrics: schema.metrics.filter((metric) => metric.name !== 'execution_time'),
    }))
    const moved = mockMove(store)
    typeInto(within(suiteBox()).getByRole('textbox', { name: 'Display name' }), 'Bench')
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric execution_time' }))
    await change('Swift', 'benchmarks')

    fireEvent.click(saveButton())
    // One prompt, saying all that the save does, confirmed by typing the suite's current name.
    expect(prompt()).toHaveTextContent('Move the test suite llvm/libcxx to swift/benchmarks?')
    // The suite named once, by its names, rather than again by its label, as if another suite.
    expect(prompt()).toHaveTextContent('Saving also removes these entries:')
    expect(prompt()).not.toHaveTextContent('llvm › libcxx')
    expect(prompt()).toHaveTextContent('Type libcxx to confirm')
    typeInto(within(prompt()!).getByRole('textbox'), 'libcxx')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/benchmarks?tab=schema'))
    expect(order).toEqual([
      '/api/projects/llvm/suites/libcxx/schema',
      '/api/projects/llvm/suites/libcxx',
    ])
    expect(patched).toEqual([
      {
        body: { display_name: 'Bench', metrics: { remove: ['execution_time'] } },
        confirm: 'true',
      },
    ])
    expect(moved.map(({ body }) => body)).toEqual([{ name: 'benchmarks', project: 'swift' }])
    // Its label tied with the other's, it comes after by its name (AR22).
    expect(chipTexts('Test suites')).toEqual(['bench', 'Bench'])
  })

  it('keeps only the rename to save when it fails once the schema is stored', async () => {
    const { store } = await openMovable()
    const patched = mockPatch(store, (schema) => ({
      ...schema,
      metrics: schema.metrics.filter((metric) => metric.name !== 'execution_time'),
    }))
    mockMove(store, { fail: () => errorResponse(409, 'retry', 'Try again.') })
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric execution_time' }))
    await change(null, 'benchmarks')
    fireEvent.click(saveButton())
    typeInto(within(prompt()!).getByRole('textbox'), 'libcxx')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))

    // The prompt closes, and the editor says why, the focus on Save.
    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('Try again.')
    expect(prompt()).not.toBeInTheDocument()
    expect(saveButton()).toHaveFocus()
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
    // The editor starts from the schema stored, keeping the name and the project.
    expect(screen.queryByRole('button', { name: /execution_time/ })).not.toBeInTheDocument()
    expect(nameInput()).toHaveValue('benchmarks')
    expect(nameInput()).not.toHaveAttribute('readonly')
    expect(rowsOf(await table('Metrics'))).toHaveLength(1)

    // Saving again asks the plain confirmation of the rename alone, and sends only that.
    const sent = mockMove(store)
    fireEvent.click(saveButton())
    expect(within(prompt()!).queryByRole('textbox')).not.toBeInTheDocument()
    expect(prompt()).not.toHaveTextContent('removes')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    expect(patched).toHaveLength(1)
    expect(sent.map(({ body }) => body)).toEqual([{ name: 'benchmarks' }])
  })

  it('shows why a rename failed below the editor, closing the prompt, as it was', async () => {
    const { store } = await openMovable()
    mockMove(store, { fail: () => errorResponse(409, 'duplicate', 'Taken meanwhile.') })
    await change(null, 'benchmarks')

    saveConfirmed()

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('Taken meanwhile.')
    expect(prompt()).not.toBeInTheDocument()
    expect(saveButton()).toHaveFocus()
    expect(nameInput()).toHaveValue('benchmarks')
    expect(nameInput()).not.toHaveAttribute('readonly')
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=schema')
  })

  it('renames it once the schema change is stored, even if the user has left the editor', async () => {
    const { store } = await openMovable()
    const held = gate()
    const patched = mockPatch(store, (schema) => ({ ...schema, display_name: 'Bench' }), {
      wait: () => held.promise,
    })
    const moved = mockMove(store)
    typeInto(within(suiteBox()).getByRole('textbox', { name: 'Display name' }), 'Bench')
    await change(null, 'benchmarks')
    saveConfirmed()
    await waitFor(() => expect(patched).toHaveLength(1))

    // Still unsaved: the user is asked first, and leaving does not cancel the save (AR19).
    answerLeaving(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(editor()).not.toBeInTheDocument()
    await act(async () => held.open())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    expect(moved.map(({ body }) => body)).toEqual([{ name: 'benchmarks' }])
    expect(await screen.findByRole('group', { name: 'Suite' })).toHaveTextContent(
      'ProjectllvmNamebenchmarksDisplay nameBench',
    )
  })

  it('renames nothing when the schema change fails, saying why in the prompt', async () => {
    const { store } = await openMovable()
    mockPatch(store, (schema) => schema, {
      fail: () => errorResponse(400, 'invalid_request', 'Bad display name.'),
    })
    const moved = mockMove(store)
    typeInto(within(suiteBox()).getByRole('textbox', { name: 'Display name' }), 'Odd')
    await change(null, 'benchmarks')

    saveConfirmed()

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent('Bad display name.')
    expect(moved).toEqual([])
    expect(within(suiteBox()).getByRole('textbox', { name: 'Display name' })).toHaveValue('Odd')
  })

  it('never shows the old names as not found on the way', async () => {
    const { store } = await openMovable()
    mockMove(store)
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(document.body.textContent ?? ''))
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    await change(null, 'benchmarks')

    saveConfirmed()
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    await waitFor(() => expect(editButton()).toHaveFocus())
    observer.disconnect()

    expect(seen.filter((text) => text.includes('not found'))).toEqual([])
  })

  it('forgets what was read under both names, and the API keys, and checks the token', async () => {
    const { store, queryClient } = await openMovable()
    const to = suiteRef('swift', 'libcxx')
    // Something read from inside the suite under its old names, which a suite created later
    // under them must not find, and from inside an earlier suite of the new names.
    queryClient.setQueryData([...queryKeys.machines(REF), 'detail', 'm'], { name: 'm' })
    queryClient.setQueryData([...queryKeys.machines(to), 'detail', 'm'], { name: 'old' })
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    mockMove(store)
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))
    await change('Swift', null)

    saveConfirmed()

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/libcxx?tab=schema'))
    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    await settle()
    expect(queryClient.getQueryCache().findAll({ queryKey: queryKeys.suite(REF) })).toEqual([])
    expect(queryClient.getQueryData([...queryKeys.machines(to), 'detail', 'm'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('disables the change once the token no longer covers the project it goes to', async () => {
    await openMovable()
    await change('Swift', null)
    fireEvent.click(saveButton())
    const ok = within(prompt()!).getByRole('button', { name: 'Save' })
    expect(ok).toBeEnabled()

    // Another tab sets a token covering the suite alone (AR17), which is checked while the prompt
    // is open.
    mockAuth(() => HttpResponse.json({ key: apiKey('manage', { restricted_to: [entry('libcxx')] }) }))
    act(() => changeInAnotherTab(TOKEN_STORAGE_KEY, 'b'.repeat(64)))

    const why = "Needs an API token with the 'manage' scope covering project 'Swift' in full."
    await waitFor(() => expect(ok).toHaveAttribute('title', expect.stringContaining(why)))
    expect(ok).toBeDisabled()
    expect(saveButton()).toHaveAttribute('title', expect.stringContaining(why))
  })

  it('goes back to the editor, sending nothing, when the prompt is cancelled', async () => {
    const { store } = await openMovable()
    const sent = mockMove(store)
    await change(null, 'benchmarks')

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(saveButton()).toHaveFocus()
    expect(nameInput()).toHaveValue('benchmarks')
    expect(sent).toEqual([])
  })

  it('leaves the focus where the user put it while the token was checked again', async () => {
    const { store } = await openMovable()
    mockMove(store)
    const held = gate()
    mockAuth(async () => {
      await held.promise
      return HttpResponse.json({ key: apiKey('manage') })
    })
    await change(null, 'benchmarks')
    saveConfirmed()
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))

    const copy = screen.getByRole('button', { name: 'Copy as JSON' })
    copy.focus()
    await act(async () => held.open())
    await waitFor(() => expect(editButton()).toBeEnabled())

    expect(copy).toHaveFocus()
  })

  it("focuses the tab's actions when the check leaves Edit schema disabled", async () => {
    const { store } = await openMovable()
    mockMove(store)
    // The key was revoked meanwhile.
    mockAuth(() => unknownToken())
    await change(null, 'benchmarks')

    saveConfirmed()

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    await waitFor(() => expect(screen.getByRole('group', { name: 'Schema actions' })).toHaveFocus())
    expect(editButton()).toBeDisabled()
  })

  it('takes the focus to the new page once only, not when the history leads back to it', async () => {
    const { store } = await openMovable(null, { from: '/projects/llvm/suites/nts' })
    mockMove(store)
    await change(null, 'benchmarks')
    saveConfirmed()
    await waitFor(() => expect(editButton()).toHaveFocus())

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts'))
    fireEvent.click(screen.getByRole('button', { name: 'Browser forward' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
    await waitFor(() => expect(editButton()).toBeEnabled())
    await settle()

    expect(editButton()).not.toHaveFocus()
  })

  it('goes to the new Schema tab when the user is on another of its tabs', async () => {
    const { store } = await openMovable()
    const held = gate()
    mockMove(store, { wait: () => held.promise })
    await change(null, 'benchmarks')
    saveConfirmed()

    // Still unsaved: the user is asked first, and leaving does not cancel the save (AR19).
    answerLeaving(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    await act(async () => held.open())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/benchmarks?tab=schema'))
  })

  it('stays where the user went, if they have left the page meanwhile', async () => {
    const { store } = await openMovable()
    const held = gate()
    mockMove(store, { wait: () => held.promise })
    await change(null, 'benchmarks')
    saveConfirmed()

    answerLeaving(true)
    fireEvent.click(chipLink('Test suites', 'nts'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=schema'))
    await act(async () => held.open())

    await waitFor(() => expect(chipTexts('Test suites')).toEqual(['benchmarks', 'nts']))
    await settle()
    expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=schema')
  })
})
