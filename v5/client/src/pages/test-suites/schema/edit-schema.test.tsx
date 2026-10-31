import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../../api/keys'
import type { SuiteSchema } from '../../../api/suites'
import { signIn } from '../../../test/auth'
import { BARE_SUITE, SUITE, cursorPage } from '../../../test/fixtures'
import { answerLeaving, unloadAsks } from '../../../test/leave'
import { errorResponse, mockApi } from '../../../test/mock-api'
import {
  currentUrl,
  gate,
  main,
  mockRuns,
  mockSuites,
  navbarLink,
  renderPage,
  rowsOf,
  settle,
  table,
  typeInto,
  type SuiteStore,
} from '../../../test/page'
import { server } from '../../../test/server'

type Failure = ReturnType<typeof errorResponse>

/** SUITE as it is stored now, changed since the list of suites was fetched. */
const FRESH: SuiteSchema = {
  ...SUITE,
  metrics: [...SUITE.metrics, { ...SUITE.metrics[0], name: 'code_size', display_name: 'Size' }],
}

/**
 * Answer `GET /api/suites/{name}` with the suite as `store` holds it, once `wait` resolves, or with
 * `fail`; returns how many times it was asked.
 */
function mockFresh(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const requests = { count: 0 }
  server.use(
    mockApi('get', '/api/suites/{name}', async ({ params }) => {
      requests.count++
      await wait?.()
      if (fail) return fail()
      const schema = store.suites.find((suite) => suite.name === params.name)
      if (!schema) return errorResponse(404, 'not_found', `No suite '${params.name}'`)
      return HttpResponse.json(schema)
    }),
  )
  return requests
}

/**
 * Answer `PATCH /api/suites/{name}/schema` with `respond`'s schema, which replaces the suite in
 * `store`, once `wait` resolves, or with `fail`; returns each request's body and `confirm`.
 */
function mockPatch(
  store: SuiteStore,
  respond: (schema: SuiteSchema) => SuiteSchema,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { body: unknown; confirm: string | null }[] = []
  server.use(
    mockApi('patch', '/api/suites/{name}/schema', async ({ request, params }) => {
      sent.push({
        body: await request.json(),
        confirm: new URL(request.url).searchParams.get('confirm'),
      })
      await wait?.()
      if (fail) return fail()
      const schema = respond(store.suites.find((suite) => suite.name === params.name)!)
      store.suites = store.suites.map((suite) => (suite.name === schema.name ? schema : suite))
      return HttpResponse.json(schema)
    }),
  )
  return sent
}

function editButton() {
  return screen.getByRole('button', { name: 'Edit schema' })
}

function editor() {
  return screen.queryByRole('region', { name: 'Editing libcxx' })
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
 * SUITE but whose server holds FRESH, and open the editor on it.
 */
async function openEditor() {
  signIn('manage')
  const store = mockSuites([SUITE, BARE_SUITE])
  const fresh = mockFresh({ ...store, suites: [FRESH, BARE_SUITE] })
  const { queryClient } = renderPage('/suites/libcxx?tab=schema')
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
    renderPage('/suites/libcxx?tab=schema')

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
    renderPage('/suites/libcxx?tab=schema')
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
    renderPage('/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    store.suites = [BARE_SUITE]

    fireEvent.click(editButton())

    expect(await main().findByRole('alert')).toHaveTextContent("Test suite 'libcxx' not found.")
    expect(editor()).not.toBeInTheDocument()
    expect(main().queryByRole('link', { name: 'libcxx' })).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
  })
})

describe('leaving the tab', () => {
  function card(name: string) {
    return within(screen.getByRole('navigation', { name: 'Test suites' })).getByRole('link', {
      name,
    })
  }

  const CODE_SIZE = { name: 'Display name of metric code_size' }

  function codeSize() {
    return screen.getByRole('textbox', CODE_SIZE)
  }

  /** Open the editor on libcxx, and change it, the Runs tab listing no runs. */
  async function openChanged() {
    mockRuns(() => cursorPage([]))
    const store = await openEditor()
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
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
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
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
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

  it('to another suite, or by Back or Forward, asks first', async () => {
    /** Change the editor, opened anew on the Schema tab shown. */
    async function changeAgain() {
      await waitFor(() => expect(editButton()).toBeEnabled())
      fireEvent.click(editButton())
      typeInto(await screen.findByRole('textbox', CODE_SIZE), 'Changed')
    }
    function browser(button: 'back' | 'forward') {
      fireEvent.click(screen.getByRole('button', { name: `Browser ${button}` }))
    }

    await openChanged()
    const confirm = answerLeaving(true)
    fireEvent.click(card('nts'))
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(confirm).toHaveBeenCalledOnce()
    browser('back')
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=schema'))
    await changeAgain()

    confirm.mockReturnValue(false)
    browser('forward')
    expect(confirm).toHaveBeenCalledTimes(2)
    expectEditor()
    confirm.mockReturnValue(true)
    browser('forward')
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(confirm).toHaveBeenCalledTimes(3)

    fireEvent.click(card('libcxx'))
    fireEvent.click(await screen.findByRole('tab', { name: 'Schema' }))
    await changeAgain()
    confirm.mockReturnValue(false)
    browser('back')
    expect(confirm).toHaveBeenCalledTimes(4)
    expectEditor()
    confirm.mockReturnValue(true)
    browser('back')
    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(confirm).toHaveBeenCalledTimes(5)
    browser('forward')
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=schema'))

    await expectViewer()
  })

  it("by the suite's own card, or the navbar, asks first", async () => {
    await openChanged()
    const confirm = answerLeaving(false)

    fireEvent.click(card('libcxx'))
    fireEvent.click(navbarLink('Graph'))
    expect(confirm).toHaveBeenCalledTimes(2)
    expectEditor()

    confirm.mockReturnValue(true)
    fireEvent.click(navbarLink('Test Suites'))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
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

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('asks first with an entry added, even without a name', async () => {
    await openEditor()
    const confirm = answerLeaving(false)
    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    expect(confirm).toHaveBeenCalledOnce()
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
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

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
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
    renderPage('/suites/libcxx?tab=schema')
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
      'NamelibcxxDisplay nameMicrobenchmarks',
    )
  })

  it('is cleared by emptying it, and left alone when only its spaces change', async () => {
    signIn('manage')
    const named = { ...SUITE, display_name: 'Micro' }
    const store = mockSuites([named, BARE_SUITE])
    mockFresh(store)
    renderPage('/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    const input = await screen.findByRole('textbox', { name: 'Display name' })
    // Named by the suite's label (AR22).
    const region = screen.getByRole('region', { name: 'Editing Micro' })
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
    store.queryClient.setQueryData([...queryKeys.machines('libcxx'), 'list'], { items: [] })

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
      store.queryClient.getQueryData([...queryKeys.machines('libcxx'), 'list']),
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
    renderPage('/suites/libcxx?tab=schema')
    await waitFor(() => expect(editButton()).toBeEnabled())
    fireEvent.click(editButton())
    fireEvent.click(await screen.findByRole('button', { name: 'Remove metric execution_time' }))

    const region = screen.getByRole('region', { name: 'Editing Micro' })
    fireEvent.click(within(region).getAllByRole('button', { name: 'Save' })[0])

    expect(prompt()).toHaveTextContent('Saving removes these entries from the suite Micro:')
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
    const notFound = await main().findByText("Test suite 'libcxx' not found.")
    expect(editor()).not.toBeInTheDocument()
    expect(notFound).toHaveFocus()
    expect(currentUrl()).toBe('/suites/libcxx?tab=schema')
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
    const card = within(screen.getByRole('navigation', { name: 'Test suites' })).getByRole('link', {
      name: 'nts',
    })
    card.focus()

    await act(async () => reply.open())

    expect(await main().findByText("Test suite 'libcxx' not found.")).not.toHaveFocus()
    expect(card).toHaveFocus()
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
      mockApi('get', '/api/suites', () => {
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
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => reply.open())
    await waitFor(() => expect(store.queryClient.isMutating()).toBe(0))
    fireEvent.click(screen.getByRole('tab', { name: 'Schema' }))

    expect(rowsOf(await table('Metrics'))[1]).toMatch(/^code_size \| real \| Changed/)
    expect(editor()).not.toBeInTheDocument()
  })
})
