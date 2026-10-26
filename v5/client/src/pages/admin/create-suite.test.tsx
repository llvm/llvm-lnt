import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { PERMISSION_DENIED } from '../../api/client'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { compareStrings } from '../../format'
import { signIn } from '../../test/auth'
import { BARE_SUITE, SUITE } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  main,
  mockSuites,
  renderPage,
  rowsOf,
  table,
  typeInto,
  type SuiteStore,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

type Failure = ReturnType<typeof errorResponse>

/**
 * Answer `POST /api/suites` by adding the suite it describes to `store`, normalized as the API
 * returns it, once `wait` resolves, or with `fail`. Returns each request's body, as sent, and its
 * `Authorization`.
 */
function mockCreate(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { text: string; auth: string | null }[] = []
  server.use(
    mockApi('post', '/api/suites', async ({ request }) => {
      const text = await request.text()
      sent.push({ text, auth: request.headers.get('Authorization') })
      await wait?.()
      if (fail) return fail()
      const body = JSON.parse(text) as Partial<SuiteSchema> & { name: string }
      const schema: SuiteSchema = {
        metrics: [],
        commit_fields: [],
        machine_fields: [],
        ...body,
      }
      store.suites = [...store.suites, schema].sort((a, b) => compareStrings(a.name, b.name))
      return HttpResponse.json(schema, { status: 201 })
    }),
  )
  return sent
}

function newSuiteButton() {
  return screen.getByRole('button', { name: 'New suite' })
}

function editor() {
  return screen.queryByRole('region', { name: 'New suite' })
}

function suiteNameInput() {
  return screen.getByRole('textbox', { name: 'Suite name' })
}

function createButton() {
  return screen.getByRole('button', { name: /^(Create|Creating\.\.\.)$/ })
}

/**
 * Show the Test Suites tab, the instance holding `suites`, to a holder of a `manage` token, and
 * open the editor creating a suite.
 */
async function openEditor({ suites = [SUITE, BARE_SUITE] }: { suites?: SuiteSchema[] } = {}) {
  signIn('manage')
  const store = mockSuites(suites)
  const { queryClient } = renderPage('/admin?tab=suites')
  await waitFor(() => expect(newSuiteButton()).toBeEnabled())
  fireEvent.click(newSuiteButton())
  await waitFor(() => expect(editor()).toBeInTheDocument())
  return Object.assign(store, { queryClient })
}

/** Add an entry to `list`, as its "+ Add" button does, naming it `name`. */
function addEntry(noun: string, name: string) {
  fireEvent.click(screen.getByRole('button', { name: `+ Add ${noun}` }))
  const inputs = screen.getAllByRole('textbox', {
    name: new RegExp(`^Name of ${noun} \\d+$`),
  })
  typeInto(inputs.at(-1)!, name)
}

describe('opening the editor', () => {
  it('needs the manage scope', async () => {
    signIn('submit')
    mockSuites()
    renderPage('/admin?tab=suites')

    await main().findByRole('list', { name: 'Test suites' })
    await waitFor(() =>
      expect(newSuiteButton()).toHaveAttribute('title', expect.stringContaining("'manage' scope")),
    )
    expect(newSuiteButton()).toBeDisabled()
  })

  it("takes the place of the tab's content, New suite included", async () => {
    await openEditor()

    expect(main().queryByRole('list', { name: 'Test suites' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'New suite' })).not.toBeInTheDocument()
    expect(suiteNameInput()).toHaveFocus()
    // It starts empty.
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
    expect(rowsOf(await table('Commit fields'))).toEqual(['No commit fields.'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['No machine fields.'])
  })

  it('discards it all on Cancel, showing the suites again', async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'draft')
    addEntry('metric', 'size')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(editor()).not.toBeInTheDocument()
    expect(main().getByRole('list', { name: 'Test suites' })).toBeInTheDocument()
    expect(newSuiteButton()).toHaveFocus()
    expect(currentUrl()).toBe('/admin?tab=suites')

    fireEvent.click(newSuiteButton())
    expect(await screen.findByRole('textbox', { name: 'Suite name' })).toHaveValue('')
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
  })

  it('is offered without suites, with nothing to start from', async () => {
    const store = await openEditor({ suites: [] })
    mockCreate(store)
    expect(selectButton('Start from')).toBeDisabled()

    typeInto(suiteNameInput(), 'first')
    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/suites/first?tab=schema'))
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
    expect(screen.queryByText('There are no test suites yet.')).not.toBeInTheDocument()
  })

  it('leaves the focus on Import JSON when it gives the editor back', async () => {
    await openEditor()

    const toggle = screen.getByRole('button', { name: 'Import JSON' })
    toggle.focus()
    fireEvent.click(toggle)
    fireEvent.click(toggle)

    expect(suiteNameInput()).not.toHaveFocus()
    expect(toggle).toHaveFocus()
  })

  it('creates the suite on Enter in its name', async () => {
    const store = await openEditor()
    const sent = mockCreate(store)

    typeInto(suiteNameInput(), 'entered')
    fireEvent.submit(suiteNameInput())

    await waitFor(() => expect(currentUrl()).toBe('/suites/entered?tab=schema'))
    expect(sent).toHaveLength(1)
  })

  it('discards it all on leaving the tab', async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'draft')

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Test Suites' }))

    await waitFor(() => expect(newSuiteButton()).toBeEnabled())
    expect(editor()).not.toBeInTheDocument()
  })
})

describe('the entries', () => {
  it('are added at the end of their list, with the focus on their name', async () => {
    await openEditor()

    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))
    const name = screen.getByRole('textbox', { name: 'Name of metric 1' })
    expect(name).toHaveFocus()
    expect(selectButton('Type of metric 1')).toHaveTextContent('real')

    fireEvent.click(screen.getByRole('button', { name: '+ Add commit field' }))
    expect(screen.getByRole('textbox', { name: 'Name of commit field 1' })).toHaveFocus()
    expect(selectButton('Type of commit field 1')).toHaveTextContent('text')

    typeInto(name, 'size')
    // Named once named, and by its place in the list until then.
    expect(screen.getByRole('textbox', { name: 'Display name of metric size' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove commit field 1' })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name of metric 1' })).toBe(name)
  })

  it('are removed, the focus going to the next one, or to the button adding one', async () => {
    await openEditor()
    addEntry('metric', 'a')
    addEntry('metric', 'b')

    fireEvent.click(screen.getByRole('button', { name: 'Remove metric a' }))
    expect(screen.getByRole('button', { name: 'Remove metric b' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric b' }))
    expect(screen.getByRole('button', { name: '+ Add metric' })).toHaveFocus()
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
  })

  it('can be searchable or the display field only while they are text', async () => {
    await openEditor()
    addEntry('commit field', 'sha')
    addEntry('commit field', 'short')

    const searchable = screen.getByRole('checkbox', {
      name: 'Searchable of commit field sha',
    })
    fireEvent.click(searchable)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Display of commit field sha' }))
    expect(searchable).toBeChecked()

    // Only one commit field is the display field.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Display of commit field short' }))
    expect(screen.getByRole('checkbox', { name: 'Display of commit field sha' })).not.toBeChecked()

    await pickOption('Type of commit field short', 'integer')
    const display = screen.getByRole('checkbox', {
      name: 'Display of commit field short',
    })
    expect(display).not.toBeChecked()
    expect(display).toBeDisabled()
    expect(display).toHaveAttribute('title', 'Only a text commit field can be the display field.')
    expect(
      screen.getByRole('checkbox', {
        name: 'Searchable of commit field short',
      }),
    ).toHaveAttribute('title', 'Only a text commit field can be searchable.')
  })

  it('can be on the Dashboard only while it is numeric', async () => {
    await openEditor()
    addEntry('metric', 'size')
    const dashboard = screen.getByRole('checkbox', { name: 'On the Dashboard of metric size' })
    expect(dashboard).not.toBeChecked()
    fireEvent.click(dashboard)

    await pickOption('Type of metric size', 'integer')
    expect(dashboard).toBeChecked()

    await pickOption('Type of metric size', 'datetime')
    expect(dashboard).not.toBeChecked()
    expect(dashboard).toBeDisabled()
    expect(dashboard).toHaveAttribute('title', 'Only a numeric metric can be on the Dashboard.')
  })
})

describe('the name checks', () => {
  it("refuse an entry's name, saying why, with the red halo", async () => {
    await openEditor()
    addEntry('metric', '2nd_size')

    const name = screen.getByRole('textbox', { name: 'Name of metric 1' })
    const why = 'A name has only letters, digits and underscores, and starts with a letter.'
    expect(name).toHaveAttribute('aria-invalid', 'true')
    expect(name).toHaveAttribute('title', why)
    expect(name).toHaveAccessibleDescription(why)

    typeInto(name, 'run_id')
    expect(name).toHaveAccessibleDescription(
      "A metric cannot be named 'machine_id', 'repetition', 'run_id' or 'test_id'.",
    )

    typeInto(name, 'size')
    expect(name).not.toHaveAttribute('aria-invalid')
    expect(name).not.toHaveAttribute('title')

    addEntry('metric', 'size')
    expect(screen.getByRole('textbox', { name: 'Name of metric 2' })).toHaveAccessibleDescription(
      "Another metric is named 'size'.",
    )
    // Refused, the name no longer names the rows' controls, which would have the same names.
    expect(screen.getByRole('button', { name: 'Remove metric 1' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove metric 2' })).toBeInTheDocument()
  })

  it("refuse the suite's name, saying why", async () => {
    await openEditor()

    typeInto(suiteNameInput(), 'pg_stats')
    expect(suiteNameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(suiteNameInput()).toHaveAccessibleDescription(
      "A suite cannot be named 'information_schema' or 'public', or start with 'pg_'.",
    )
    typeInto(suiteNameInput(), 'nts')
    expect(suiteNameInput()).toHaveAccessibleDescription("There is already a suite named 'nts'.")
    typeInto(suiteNameInput(), 'fresh')
    expect(suiteNameInput()).not.toHaveAttribute('aria-invalid')
  })

  it('keep Create disabled, saying why, until every name is fine', async () => {
    await openEditor()
    const reason = () => createButton().getAttribute('title')

    expect(createButton()).toBeDisabled()
    expect(reason()).toBe('Give the suite a name first.')
    expect(createButton()).toHaveAccessibleDescription('Give the suite a name first.')

    typeInto(suiteNameInput(), 'Fresh')
    expect(reason()).toMatch(/lowercase letters/)
    typeInto(suiteNameInput(), 'fresh')
    expect(createButton()).toBeEnabled()
    expect(reason()).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '+ Add machine field' }))
    expect(reason()).toBe('Give every new entry a name first.')
    // An empty name is not invalid text, only a missing one.
    expect(screen.getByRole('textbox', { name: 'Name of machine field 1' })).not.toHaveAttribute(
      'aria-invalid',
    )

    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 1' }), 'tracked')
    expect(reason()).toBe('Correct the names marked in red first.')
    typeInto(screen.getByRole('textbox', { name: 'Name of machine field 1' }), 'kernel')
    expect(createButton()).toBeEnabled()
  })
})

describe('creating the suite', () => {
  it("sends the schema, then goes to the new suite's Schema tab", async () => {
    const store = await openEditor()
    const sent = mockCreate(store)
    typeInto(suiteNameInput(), 'fresh')
    addEntry('metric', 'size')
    await pickOption('Type of metric size', 'integer')
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric size' }), ' Size  ')
    typeInto(screen.getByRole('textbox', { name: 'Unit abbreviation of metric size' }), '   ')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bigger is better of metric size' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'On the Dashboard of metric size' }))
    addEntry('machine field', 'kernel')

    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/suites/fresh?tab=schema'))
    expect(JSON.parse(sent[0].text)).toEqual({
      name: 'fresh',
      metrics: [
        {
          name: 'size',
          type: 'integer',
          display_name: 'Size',
          unit: null,
          unit_abbrev: null,
          bigger_is_better: true,
          dashboard: true,
        },
      ],
      commit_fields: [],
      machine_fields: [
        { name: 'kernel', type: 'text', display_name: null, searchable: false, listed: false },
      ],
    })
    expect(sent[0].auth).toMatch(/^Bearer /)
    expect(editor()).not.toBeInTheDocument()
    expect(rowsOf(await table('Metrics'))).toEqual(['size | integer | Size | -- | Yes | Yes'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['kernel | text | -- | No | No'])

    // A page of its own: Back returns to the Admin page.
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(await main().findByRole('link', { name: 'fresh' })).toBeInTheDocument()
  })

  it('creates a suite without entries', async () => {
    const store = await openEditor()
    const sent = mockCreate(store)
    typeInto(suiteNameInput(), 'empty')

    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/suites/empty?tab=schema'))
    expect(JSON.parse(sent[0].text)).toEqual({
      name: 'empty',
      metrics: [],
      commit_fields: [],
      machine_fields: [],
    })
  })

  it('changes nothing while it is under way, keeping the focus', async () => {
    const store = await openEditor()
    const reply = gate()
    const sent = mockCreate(store, { wait: () => reply.promise })
    typeInto(suiteNameInput(), 'fresh')
    addEntry('metric', 'size')

    createButton().focus()
    fireEvent.click(createButton())

    await waitFor(() => expect(createButton()).toHaveTextContent('Creating...'))
    expect(createButton()).toHaveFocus()
    expect(createButton()).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(createButton())
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric size' }))
    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))
    expect(suiteNameInput()).toHaveAttribute('readonly')
    expect(rowsOf(await table('Metrics'))).toHaveLength(1)
    expect(editor()).toBeInTheDocument()

    await act(async () => reply.open())
    await waitFor(() => expect(editor()).not.toBeInTheDocument())
    expect(sent).toHaveLength(1)
  })

  it('keeps the editor as it was on a failure, with the reason', async () => {
    const store = await openEditor()
    mockCreate(store, {
      fail: () => errorResponse(400, 'invalid_request', "'size' is not a valid metric name"),
    })
    typeInto(suiteNameInput(), 'fresh')
    addEntry('metric', 'size')

    fireEvent.click(createButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent(
      "'size' is not a valid metric name",
    )
    expect(suiteNameInput()).toHaveValue('fresh')
    expect(screen.getByRole('textbox', { name: 'Name of metric 1' })).toHaveValue('size')
    expect(createButton()).toBeEnabled()
  })

  it('says that permission is denied when the API refuses the token', async () => {
    const store = await openEditor()
    mockCreate(store, {
      fail: () => errorResponse(403, 'forbidden', 'Needs manage.'),
    })
    typeInto(suiteNameInput(), 'fresh')

    fireEvent.click(createButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
  })

  it('has the name check say that a suite created elsewhere took the name', async () => {
    const store = await openEditor()
    mockCreate(store, {
      fail: () => {
        store.suites = [...store.suites, { ...BARE_SUITE, name: 'fresh' }]
        return errorResponse(409, 'duplicate', "Suite 'fresh' already exists")
      },
    })
    typeInto(suiteNameInput(), 'fresh')

    fireEvent.click(createButton())

    await waitFor(() =>
      expect(suiteNameInput()).toHaveAccessibleDescription(
        "There is already a suite named 'fresh'.",
      ),
    )
    expect(within(editor()!).getByRole('alert')).toHaveTextContent("Suite 'fresh' already exists")
  })

  it('keeps the editor when the list fetched again after a taken name fails', async () => {
    const store = await openEditor()
    mockCreate(store, {
      fail: () => {
        server.use(
          mockApi('get', '/api/suites', () =>
            errorResponse(500, 'internal_error', 'The database is down.'),
          ),
        )
        return errorResponse(409, 'duplicate', "Suite 'fresh' already exists")
      },
    })
    typeInto(suiteNameInput(), 'fresh')

    fireEvent.click(createButton())

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent('already exists')
    await waitFor(() =>
      expect(store.queryClient.getQueryState(queryKeys.suites)?.status).toBe('error'),
    )
    expect(editor()).toBeInTheDocument()
    expect(suiteNameInput()).toHaveValue('fresh')
  })

  it('keeps the new suite when a list on its way does not hold it yet', async () => {
    const store = await openEditor()
    mockCreate(store)
    typeInto(suiteNameInput(), 'fresh')
    const stale = gate()
    const refetched = mockSuites([SUITE, BARE_SUITE], {
      wait: () => stale.promise,
    })
    void store.queryClient.refetchQueries({ queryKey: queryKeys.suites })
    await waitFor(() => expect(refetched.requests).toBe(1))

    // Lists asked for from now on hold what the instance does.
    server.use(mockApi('get', '/api/suites', () => HttpResponse.json({ items: store.suites })))

    fireEvent.click(createButton())
    await waitFor(() => expect(currentUrl()).toBe('/suites/fresh?tab=schema'))
    await act(async () => stale.open())
    await waitFor(() => expect(store.queryClient.isFetching()).toBe(0))

    expect(await table('Metrics')).toBeInTheDocument()
    expect(screen.queryByText("Test suite 'fresh' not found.")).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/suites/fresh?tab=schema')
  })

  it('stays where the user is once done if they have left the tab meanwhile', async () => {
    const store = await openEditor()
    const reply = gate()
    mockCreate(store, { wait: () => reply.promise })
    typeInto(suiteNameInput(), 'fresh')
    fireEvent.click(createButton())
    await waitFor(() => expect(createButton()).toHaveTextContent('Creating...'))

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    await act(async () => reply.open())
    await waitFor(() => expect(store.queryClient.isMutating()).toBe(0))
    expect(currentUrl()).toBe('/admin')

    // The suite was created all the same, and is in the list.
    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
    expect(await main().findByRole('link', { name: 'fresh' })).toBeInTheDocument()
  })
})

describe('Start from', () => {
  it("copies a suite's entries, keeping the name typed, as often as asked", async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'copy')
    addEntry('metric', 'mine')

    await pickOption('Start from', 'libcxx')

    expect(suiteNameInput()).toHaveValue('copy')
    expect(
      screen
        .getAllByRole('textbox', { name: /^Name of metric/ })
        .map((i) => i.getAttribute('value')),
    ).toEqual(['execution_time'])
    expect(
      screen.getByRole('textbox', {
        name: 'Display name of metric execution_time',
      }),
    ).toHaveValue('Execution Time')
    expect(
      screen
        .getAllByRole('textbox', { name: /^Name of machine field/ })
        .map((i) => i.getAttribute('value')),
    ).toEqual(['hardware', 'os', 'core_count'])
    expect(
      screen.getByRole('checkbox', {
        name: 'Display of commit field svn_revision',
      }),
    ).toBeChecked()
    expect(selectButton('Start from')).toHaveTextContent('Select a suite')

    // Picking it again starts again from it.
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric execution_time' }))
    await pickOption('Start from', 'libcxx')
    expect(screen.getAllByRole('textbox', { name: /^Name of metric/ })).toHaveLength(1)
  })

  it('changes nothing from the keyboard while its list is closed', async () => {
    await openEditor()
    const user = userEvent.setup()

    selectButton('Start from').focus()
    await user.keyboard('{ArrowRight}{ArrowRight}l')

    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
  })
})

describe('Import JSON', () => {
  const DOCUMENT = '{\n  "name": "imported",\n  "metrics": [{"name": "size", "type": "real"}]\n}'

  function importToggle() {
    return screen.getByRole('button', { name: 'Import JSON' })
  }

  function documentInput() {
    return screen.getByRole('textbox', { name: /^Schema document/ })
  }

  it('takes the place of the editor, which it gives back as it was', async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'draft')
    addEntry('metric', 'size')

    fireEvent.click(importToggle())
    expect(importToggle()).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('textbox', { name: 'Suite name' })).not.toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Metrics' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    typeInto(documentInput(), DOCUMENT)

    fireEvent.click(importToggle())
    expect(suiteNameInput()).toHaveValue('draft')
    expect(screen.getByRole('textbox', { name: 'Name of metric 1' })).toHaveValue('size')

    fireEvent.click(importToggle())
    expect(documentInput()).toHaveValue(DOCUMENT)
  })

  it("sends the document as it is, then goes to the new suite's Schema tab", async () => {
    const store = await openEditor()
    const sent = mockCreate(store)
    fireEvent.click(importToggle())
    const send = screen.getByRole('button', { name: 'Create from JSON' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Paste or load a schema document first.')

    typeInto(documentInput(), DOCUMENT)
    fireEvent.click(send)

    await waitFor(() => expect(currentUrl()).toBe('/suites/imported?tab=schema'))
    expect(sent[0].text).toBe(DOCUMENT)
    expect(editor()).not.toBeInTheDocument()
    expect(rowsOf(await table('Metrics'))).toEqual(['size | real | -- | -- | No | No'])
  })

  it('loads the document from a file', async () => {
    await openEditor()
    fireEvent.click(importToggle())

    const file = new File([DOCUMENT], 'imported.json', {
      type: 'application/json',
    })
    await userEvent.setup().upload(screen.getByLabelText('Load from file'), file)

    await waitFor(() => expect(documentInput()).toHaveValue(DOCUMENT))
  })

  it('keeps the document on a failure, with the reason', async () => {
    const store = await openEditor()
    mockCreate(store, {
      fail: () => errorResponse(400, 'invalid_request', 'The body is not valid JSON.'),
    })
    fireEvent.click(importToggle())
    typeInto(documentInput(), '{"name": ')

    fireEvent.click(screen.getByRole('button', { name: 'Create from JSON' }))

    expect(await within(editor()!).findByRole('alert')).toHaveTextContent(
      'The body is not valid JSON.',
    )
    expect(documentInput()).toHaveValue('{"name": ')
  })
})
