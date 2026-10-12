import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { signIn } from '../../test/auth'
import { BARE_SUITE, SUITE } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  mockSuites,
  renderPage,
  rowsOf,
  table,
  typeInto,
  type SuiteStore,
} from '../../test/page'
import { pickOption } from '../../test/select'
import { server } from '../../test/server'

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
 * Show libcxx in the Test Suites tab to a holder of a `manage` token, whose list of suites holds
 * SUITE but whose server holds FRESH, and open the editor on it.
 */
async function openEditor() {
  signIn('manage')
  const store = mockSuites([SUITE, BARE_SUITE])
  const fresh = mockFresh({ ...store, suites: [FRESH, BARE_SUITE] })
  const { queryClient } = renderPage('/admin?tab=suites&suite=libcxx')
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
    renderPage('/admin?tab=suites&suite=libcxx')

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
    expect(screen.getByRole('button', { name: / Test suite$/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'New suite' })).toBeDisabled()
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
    renderPage('/admin?tab=suites&suite=libcxx')
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
    renderPage('/admin?tab=suites&suite=libcxx')
    await waitFor(() => expect(editButton()).toBeEnabled())
    store.suites = [BARE_SUITE]

    fireEvent.click(editButton())

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(editor()).not.toBeInTheDocument()
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

describe('saving', () => {
  it('sends only what changed, then shows the schema saved', async () => {
    const store = await openEditor()
    const sent = mockPatch(store, (schema) => ({
      ...schema,
      metrics: schema.metrics.map((metric) =>
        metric.name === 'code_size' ? { ...metric, display_name: 'Code size' } : metric,
      ),
      machine_fields: [
        ...schema.machine_fields,
        { name: 'kernel', type: 'text', display_name: null, searchable: false },
      ],
    }))
    // Read from inside the suite, before its schema changed.
    store.queryClient.setQueryData([...queryKeys.machines('libcxx'), 'list'], { items: [] })

    typeInto(screen.getByRole('textbox', { name: 'Display name of metric code_size' }), 'Code size')
    fireEvent.click(screen.getByRole('button', { name: '+ Add machine field' }))
    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 4' }), 'kernel')
    fireEvent.click(saveButton())

    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toEqual([
      {
        body: {
          metrics: { update: [{ name: 'code_size', display_name: 'Code size' }] },
          machine_fields: {
            add: [{ name: 'kernel', type: 'text', display_name: null, searchable: false }],
          },
        },
        confirm: null,
      },
    ])
    expect(rowsOf(await table('Metrics'))[1]).toBe(
      'code_size | real | Code size | seconds (s) | No',
    )
    expect(rowsOf(await table('Machine fields')).at(-1)).toBe('kernel | text | -- | No')
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

    fireEvent.click(saveButton())

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(editor()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: / Test suite$/ })).toHaveFocus()
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

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await act(async () => reply.open())
    await waitFor(() => expect(store.queryClient.isMutating()).toBe(0))
    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
    await pickOption('Test suite', 'libcxx')

    expect(rowsOf(await table('Metrics'))[1]).toMatch(/^code_size \| real \| Changed/)
    expect(editor()).not.toBeInTheDocument()
  })
})
