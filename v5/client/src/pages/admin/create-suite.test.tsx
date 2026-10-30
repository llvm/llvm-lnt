import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { PERMISSION_DENIED, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import type { ProjectName, Suite, SuiteSchema } from '../../api/suites'
import { compareStrings } from '../../format'
import { entry, signIn } from '../../test/auth'
import { BARE_SUITE, NO_REPOSITORY, PROJECT, SUITE, inProject } from '../../test/fixtures'
import { renderWithProviders } from '../../test/render'
import { CreateSuite } from './create-suite'
import { answerLeaving, unloadAsks } from '../../test/leave'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  mockSuites,
  renderPage,
  projectList,
  rowsOf,
  table,
  typeInto,
  type SuiteStore,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

type Failure = ReturnType<typeof errorResponse>

/** Another project, with a display name, holding no suite at first. */
const SWIFT: ProjectName = { name: 'swift', display_name: 'Swift' }

/**
 * Answer `POST /api/projects/{project}/suites` by adding the suite it describes to `store`, in the
 * project, normalized as the API returns it, once `wait` resolves, or with `fail`. Returns each
 * request's project, body, as sent, and `Authorization`.
 */
function mockCreate(
  store: SuiteStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  const sent: { project: string; text: string; auth: string | null }[] = []
  server.use(
    mockApi('post', '/api/projects/{project}/suites', async ({ request, params }) => {
      const text = await request.text()
      sent.push({ project: params.project, text, auth: request.headers.get('Authorization') })
      await wait?.()
      if (fail) return fail()
      const body = JSON.parse(text) as Partial<SuiteSchema> & { name: string }
      const schema: SuiteSchema = {
        display_name: null,
        metrics: [],
        commit_fields: [],
        machine_fields: [],
        ...body,
        repository: { ...NO_REPOSITORY, ...body.repository },
      }
      const project = store.projects.find((candidate) => candidate.name === params.project)!
      const suite = inProject(schema, project)
      store.suites = [...store.suites, suite].sort((a, b) => compareStrings(a.name, b.name))
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

function displayNameInput() {
  return screen.getByRole('textbox', { name: 'Display name' })
}

function createButton() {
  return screen.getByRole('button', { name: /^(Create|Creating\.\.\.)$/ })
}

/**
 * Show the Test Suites tab, the instance holding `suites` in `projects`, to a holder of a `manage`
 * token, and open the editor creating a suite, once it has loaded the projects, picking `pick`
 * unless null.
 */
async function openEditor({
  suites = [SUITE, BARE_SUITE],
  projects,
  pick = PROJECT.name,
}: { suites?: (Suite | SuiteSchema)[]; projects?: ProjectName[]; pick?: string | null } = {}) {
  signIn('manage')
  const store = mockSuites(suites, { projects })
  const { queryClient } = renderPage('/admin?tab=suites')
  await waitFor(() => expect(newSuiteButton()).toBeEnabled())
  fireEvent.click(newSuiteButton())
  await waitFor(() => expect(editor()).toBeInTheDocument())
  await waitFor(() => expect(queryClient.getQueryState(queryKeys.projects)?.status).toBe('success'))
  if (pick !== null) await pickOption('Project', pick)
  return Object.assign(store, { queryClient })
}

/** The names the suites listed in the cache have, as `project/suite`. */
function cachedSuites(queryClient: QueryClient) {
  return queryClient
    .getQueryData<Schemas['ProjectList']>(queryKeys.projects)
    ?.items.flatMap((project) => project.suites.map((suite) => `${project.name}/${suite.name}`))
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

    await waitFor(() =>
      expect(newSuiteButton()).toHaveAttribute('title', expect.stringContaining("'manage' scope")),
    )
    expect(newSuiteButton()).toBeDisabled()
  })

  it('needs a token covering a project in full, rather than one restricted to suites', async () => {
    signIn('manage', [entry('nts')])
    mockSuites([SUITE, BARE_SUITE], { projects: [PROJECT, SWIFT] })
    renderPage('/admin?tab=suites')

    // A suite is created in a project, which the token must cover in full.
    await waitFor(() =>
      expect(newSuiteButton()).toHaveAccessibleDescription(
        "Needs an API token with the 'manage' scope covering a project in full. The token in " +
          "Settings has the 'manage' scope only in suite 'llvm/nts'.",
      ),
    )
    expect(newSuiteButton()).toBeDisabled()
  })

  it('names the project needed when there is only one', async () => {
    signIn('manage', [entry('nts')])
    mockSuites()
    renderPage('/admin?tab=suites')

    await waitFor(() =>
      expect(newSuiteButton()).toHaveAccessibleDescription(
        "Needs an API token with the 'manage' scope covering project 'llvm' in full. The token " +
          "in Settings has the 'manage' scope only in suite 'llvm/nts'.",
      ),
    )
  })

  it('is disabled while there are no projects to create a suite in', async () => {
    signIn('manage')
    mockSuites([], { projects: [] })
    renderPage('/admin?tab=suites')

    await waitFor(() =>
      expect(newSuiteButton()).toHaveAccessibleDescription(
        'There are no projects to create a suite in.',
      ),
    )
    expect(newSuiteButton()).toBeDisabled()
  })

  it('waits for the projects, which it needs to say whether a suite can be created', async () => {
    signIn('manage')
    const list = gate()
    mockSuites([SUITE, BARE_SUITE], { wait: () => list.promise })
    renderPage('/admin?tab=suites')

    await waitFor(() =>
      expect(newSuiteButton()).toHaveAccessibleDescription('Loading the projects...'),
    )
    await act(async () => list.open())
    await waitFor(() => expect(newSuiteButton()).toBeEnabled())
  })

  it('says why the projects could not be loaded, and loads them again', async () => {
    signIn('manage')
    server.use(
      mockApi('get', '/api/projects', () =>
        errorResponse(500, 'internal_error', 'The database is down.'),
      ),
    )
    renderPage('/admin?tab=suites')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The projects could not be loaded: The database is down.',
    )
    expect(newSuiteButton()).toHaveAccessibleDescription('The projects could not be loaded.')

    mockSuites()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(newSuiteButton()).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('creates nothing until the projects have loaded', async () => {
    // Rendered on its own: the tab opens the editor only once the projects have loaded.
    signIn('manage')
    const list = gate()
    mockSuites([SUITE, BARE_SUITE], { wait: () => list.promise })
    renderWithProviders(<CreateSuite onCancel={() => {}} onCreated={() => {}} />)
    typeInto(await screen.findByRole('textbox', { name: 'Suite name' }), 'libcxx')

    expect(selectButton('Project')).toBeDisabled()
    expect(selectButton('Start from')).toBeDisabled()
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAccessibleDescription('Loading the projects...')
    await act(async () => list.open())

    await waitFor(() => expect(selectButton('Project')).toBeEnabled())
    expect(selectButton('Start from')).toBeEnabled()
    expect(createButton()).toHaveAccessibleDescription('Pick a project first.')
    // The name is checked against the suites of the project picked.
    await pickOption('Project', 'llvm')
    expect(createButton()).toHaveAccessibleDescription("There is already a suite named 'libcxx'.")
  })

  it('says why the projects could not be loaded in the editor, and loads them again', async () => {
    signIn('manage')
    server.use(
      mockApi('get', '/api/projects', () =>
        errorResponse(500, 'internal_error', 'The database is down.'),
      ),
    )
    renderWithProviders(<CreateSuite onCancel={() => {}} onCreated={() => {}} />)
    typeInto(await screen.findByRole('textbox', { name: 'Suite name' }), 'fresh')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The projects could not be loaded: The database is down.',
    )
    expect(createButton()).toHaveAccessibleDescription('The projects could not be loaded.')

    mockSuites()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(selectButton('Project')).toBeEnabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await pickOption('Project', 'llvm')
    expect(createButton()).toBeEnabled()
  })

  it("takes the place of the tab's content, New suite included", async () => {
    await openEditor({ pick: null })

    expect(screen.queryByRole('button', { name: 'New suite' })).not.toBeInTheDocument()
    expect(suiteNameInput()).toHaveFocus()
    // It starts empty.
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
    expect(rowsOf(await table('Commit fields'))).toEqual(['No commit fields.'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['No machine fields.'])
  })

  it('discards it all on Cancel, giving New suite back', async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'draft')
    addEntry('metric', 'size')

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(editor()).not.toBeInTheDocument()
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

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/first?tab=schema'))
    expect(rowsOf(await table('Metrics'))).toEqual(['No metrics.'])
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

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/entered?tab=schema'))
    expect(sent).toHaveLength(1)
  })

  it('asks before it is left with anything entered, discarding it all if confirmed', async () => {
    await openEditor()
    const confirm = answerLeaving(false)
    typeInto(suiteNameInput(), 'draft')

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect(currentUrl()).toBe('/admin?tab=suites')
    expect(suiteNameInput()).toHaveValue('draft')

    confirm.mockReturnValue(true)
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    fireEvent.click(await screen.findByRole('tab', { name: 'Test Suites' }))

    await waitFor(() => expect(newSuiteButton()).toBeEnabled())
    expect(editor()).not.toBeInTheDocument()
  })

  it('is left without asking while nothing is entered', async () => {
    await openEditor({ pick: null })
    const confirm = answerLeaving(false)
    expect(unloadAsks()).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))

    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    expect(confirm).not.toHaveBeenCalled()
  })

  it('has unsaved changes once a project is picked', async () => {
    await openEditor({ pick: null })
    expect(unloadAsks()).toBe(false)

    await pickOption('Project', 'llvm')
    expect(unloadAsks()).toBe(true)
  })

  it('has unsaved changes once a name, an entry or a repository value is entered', async () => {
    await openEditor({ pick: null })

    typeInto(displayNameInput(), ' ')
    expect(unloadAsks()).toBe(false)
    typeInto(displayNameInput(), 'Draft')
    expect(unloadAsks()).toBe(true)
    typeInto(displayNameInput(), '')

    typeInto(screen.getByRole('textbox', { name: 'Range URL' }), ' ')
    expect(unloadAsks()).toBe(false)
    typeInto(screen.getByRole('textbox', { name: 'Range URL' }), 'h')
    expect(unloadAsks()).toBe(true)
    typeInto(screen.getByRole('textbox', { name: 'Range URL' }), '')

    typeInto(suiteNameInput(), 'draft')
    expect(unloadAsks()).toBe(true)
    typeInto(suiteNameInput(), '')
    expect(unloadAsks()).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: '+ Add metric' }))
    expect(unloadAsks()).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric 1' }))
    expect(unloadAsks()).toBe(false)

    // A suite without entries leaves the editor as it opened.
    await pickOption('Start from', 'llvm/nts')
    expect(unloadAsks()).toBe(false)
    await pickOption('Start from', 'llvm/libcxx')
    expect(unloadAsks()).toBe(true)
  })

  it('has unsaved changes once a document that is not blank is entered', async () => {
    await openEditor()
    const confirm = answerLeaving(false)

    fireEvent.click(screen.getByRole('button', { name: 'Import JSON' }))
    typeInto(screen.getByRole('textbox', { name: /^Schema document/ }), '{}')
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    expect(confirm).toHaveBeenCalledOnce()
  })
})

describe('the Project dropdown', () => {
  it('lists every project by its label, with none picked, and needs one to create', async () => {
    await openEditor({ projects: [SWIFT, PROJECT], pick: null })
    typeInto(suiteNameInput(), 'fresh')

    expect(selectButton('Project')).toHaveTextContent('Select a project')
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAccessibleDescription('Pick a project first.')
    const user = userEvent.setup()
    await user.click(selectButton('Project'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'llvm',
      'Swift',
    ])
    await user.click(screen.getByRole('option', { name: 'Swift' }))

    expect(selectButton('Project')).toHaveTextContent('Swift')
    expect(createButton()).toBeEnabled()
  })

  it('disables the projects the token does not cover in full, saying why', async () => {
    // Rendered on its own: the tab opens the editor only for a token covering some project.
    signIn('manage', [entry('nts')])
    mockSuites([SUITE, BARE_SUITE], { projects: [PROJECT, SWIFT] })
    renderWithProviders(<CreateSuite onCancel={() => {}} onCreated={() => {}} />)
    await waitFor(() => expect(selectButton('Project')).toBeEnabled())

    await userEvent.setup().click(selectButton('Project'))
    const why =
      "Needs an API token with the 'manage' scope covering project 'Swift' in full. The token " +
      "in Settings has the 'manage' scope only in suite 'llvm/nts'."
    const options = await screen.findAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-disabled'))).toEqual(['true', 'true'])
    // Saying why on hover, and to assistive technology.
    expect(options[1]).toHaveTextContent(`Swift: ${why}`)
    expect(within(options[1]).getByTitle(why)).toBeInTheDocument()
  })

  it('checks the name against the suites of the project picked alone', async () => {
    await openEditor({ projects: [PROJECT, SWIFT], pick: 'Swift' })

    typeInto(suiteNameInput(), 'nts')
    expect(suiteNameInput()).not.toHaveAttribute('aria-invalid')
    expect(createButton()).toBeEnabled()

    await pickOption('Project', 'llvm')
    expect(suiteNameInput()).toHaveAccessibleDescription("There is already a suite named 'nts'.")
    expect(createButton()).toBeDisabled()
  })

  it("creates the suite in the project picked, then goes to the suite's Schema tab", async () => {
    const store = await openEditor({ projects: [PROJECT, SWIFT], pick: 'Swift' })
    const sent = mockCreate(store)
    typeInto(suiteNameInput(), 'nts')

    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/nts?tab=schema'))
    expect(sent.map(({ project }) => project)).toEqual(['swift'])
    expect(cachedSuites(store.queryClient)).toContain('swift/nts')
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

    typeInto(suiteNameInput(), '-stats')
    expect(suiteNameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(suiteNameInput()).toHaveAccessibleDescription(
      "A name has only lowercase letters, digits, '-' and '_', and starts with a letter or a digit.",
    )
    typeInto(suiteNameInput(), 'nts')
    expect(suiteNameInput()).toHaveAccessibleDescription("There is already a suite named 'nts'.")
    typeInto(suiteNameInput(), 'fresh-2')
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

describe('the URL checks', () => {
  it('refuse a repository URL, saying why, with the red halo, and keep Create disabled', async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'fresh')
    const url = screen.getByRole('textbox', { name: 'Range URL' })
    const hint =
      '{from} and {to} are replaced by the commit the changes start after and the one they end at.'
    expect(url).toHaveAccessibleDescription(hint)

    typeInto(url, 'https://{from}.example.com/{to}')
    const why = 'A URL names its host as it is, without a placeholder.'
    expect(url).toHaveAttribute('aria-invalid', 'true')
    expect(url).toHaveAttribute('title', why)
    expect(url).toHaveAccessibleDescription(`${hint} ${why}`)
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAttribute(
      'title',
      'Correct the repository URLs marked in red first.',
    )

    // Checked as it would be sent.
    typeInto(url, ' https://example.com/{from}...{to} ')
    expect(url).not.toHaveAttribute('aria-invalid')
    expect(createButton()).toBeEnabled()
  })
})

describe('creating the suite', () => {
  it("sends the schema, then goes to the new suite's Schema tab", async () => {
    const store = await openEditor()
    const sent = mockCreate(store)
    const confirm = answerLeaving(false)
    typeInto(suiteNameInput(), 'fresh')
    typeInto(screen.getByRole('textbox', { name: 'Display name' }), ' Fresh suite ')
    addEntry('metric', 'size')
    await pickOption('Type of metric size', 'integer')
    typeInto(screen.getByRole('textbox', { name: 'Display name of metric size' }), ' Size  ')
    typeInto(screen.getByRole('textbox', { name: 'Unit abbreviation of metric size' }), '   ')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Bigger is better of metric size' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'On the Dashboard of metric size' }))
    addEntry('machine field', 'kernel')
    typeInto(screen.getByRole('textbox', { name: 'Label' }), ' Forge ')
    typeInto(screen.getByRole('textbox', { name: 'Commit URL' }), ' https://git.example.com/{commit}')

    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/fresh?tab=schema'))
    expect(JSON.parse(sent[0].text)).toEqual({
      name: 'fresh',
      display_name: 'Fresh suite',
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
      repository: { label: 'Forge', commit_url: 'https://git.example.com/{commit}', range_url: null },
    })
    expect(sent[0].auth).toMatch(/^Bearer /)
    expect(confirm).not.toHaveBeenCalled()
    expect(editor()).not.toBeInTheDocument()
    expect(await screen.findByRole('group', { name: 'Suite' })).toHaveTextContent(
      'ProjectllvmNamefreshDisplay nameFresh suite',
    )
    expect(rowsOf(await table('Metrics'))).toEqual(['size | integer | Size | -- | Yes | Yes'])
    expect(rowsOf(await table('Machine fields'))).toEqual(['kernel | text | -- | No | No'])
    expect(screen.getByRole('group', { name: 'Repository' })).toHaveTextContent(
      'LabelForgeCommit URLhttps://git.example.com/{commit}Range URL--',
    )

    // A page of its own: Back returns to the Admin page.
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
    expect(await screen.findByRole('button', { name: 'New suite' })).toBeInTheDocument()
  })

  it('creates a suite without entries', async () => {
    const store = await openEditor()
    const sent = mockCreate(store)
    typeInto(suiteNameInput(), 'empty')

    fireEvent.click(createButton())

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/empty?tab=schema'))
    expect(JSON.parse(sent[0].text)).toEqual({
      name: 'empty',
      display_name: null,
      metrics: [],
      commit_fields: [],
      machine_fields: [],
      repository: NO_REPOSITORY,
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
          mockApi('get', '/api/projects', () =>
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
      expect(store.queryClient.getQueryState(queryKeys.projects)?.status).toBe('error'),
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
    void store.queryClient.refetchQueries({ queryKey: queryKeys.projects })
    await waitFor(() => expect(refetched.requests).toBe(1))

    // Lists asked for from now on hold what the instance does.
    server.use(
      mockApi('get', '/api/projects', () =>
        HttpResponse.json(projectList(store.suites, store.projects)),
      ),
    )

    fireEvent.click(createButton())
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/fresh?tab=schema'))
    await act(async () => stale.open())
    await waitFor(() => expect(store.queryClient.isFetching()).toBe(0))

    expect(await table('Metrics')).toBeInTheDocument()
    expect(screen.queryByText("Test suite 'fresh' not found.")).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/projects/llvm/suites/fresh?tab=schema')
  })

  it('stays where the user is once done if they have left the tab meanwhile', async () => {
    const store = await openEditor()
    const reply = gate()
    mockCreate(store, { wait: () => reply.promise })
    typeInto(suiteNameInput(), 'fresh')
    fireEvent.click(createButton())
    await waitFor(() => expect(createButton()).toHaveTextContent('Creating...'))

    // Not created yet: the user is asked first, and leaving does not cancel the creation.
    const confirm = answerLeaving(true)
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    expect(confirm).toHaveBeenCalledOnce()
    await act(async () => reply.open())
    await waitFor(() => expect(store.queryClient.isMutating()).toBe(0))
    expect(currentUrl()).toBe('/admin')

    // The suite was created all the same, and is in the list of suites.
    expect(cachedSuites(store.queryClient)).toContain('llvm/fresh')
  })
})

describe('Start from', () => {
  it("copies a suite's entries, keeping the name typed, as often as asked", async () => {
    await openEditor()
    typeInto(suiteNameInput(), 'copy')
    addEntry('metric', 'mine')

    await pickOption('Start from', 'llvm/libcxx')

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
    expect(screen.getByRole('textbox', { name: 'Commit URL' })).toHaveValue(
      SUITE.repository.commit_url,
    )
    expect(selectButton('Start from')).toHaveTextContent('Select a suite')

    // Picking it again starts again from it.
    fireEvent.click(screen.getByRole('button', { name: 'Remove metric execution_time' }))
    await pickOption('Start from', 'llvm/libcxx')
    expect(screen.getAllByRole('textbox', { name: /^Name of metric/ })).toHaveLength(1)
  })

  it("lists the suites by their labels, in their order, and copies neither one's names", async () => {
    await openEditor({
      suites: [{ ...SUITE, display_name: 'Microbenchmarks' }, { ...BARE_SUITE, name: 'alpha' }],
    })
    typeInto(displayNameInput(), ' Mine ')
    const user = userEvent.setup()
    await user.click(selectButton('Start from'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Select a suite',
      'llvm/alpha',
      'llvm/Microbenchmarks',
    ])
    await user.click(screen.getByRole('option', { name: 'llvm/Microbenchmarks' }))

    expect(suiteNameInput()).toHaveValue('')
    expect(displayNameInput()).toHaveValue(' Mine ')
    expect(
      screen
        .getAllByRole('textbox', { name: /^Name of metric/ })
        .map((i) => i.getAttribute('value')),
    ).toEqual(['execution_time'])
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

  it('is disabled until a project is picked', async () => {
    await openEditor({ pick: null })

    expect(importToggle()).toBeDisabled()
    expect(importToggle()).toHaveAccessibleDescription('Pick a project first.')
    await pickOption('Project', 'llvm')
    expect(importToggle()).toBeEnabled()
  })

  it('sends the document to the project picked', async () => {
    const store = await openEditor({ projects: [PROJECT, SWIFT], pick: 'Swift' })
    const sent = mockCreate(store)
    fireEvent.click(importToggle())
    typeInto(documentInput(), DOCUMENT)

    fireEvent.click(screen.getByRole('button', { name: 'Create from JSON' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/imported?tab=schema'))
    expect(sent.map(({ project }) => project)).toEqual(['swift'])
  })

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
    const confirm = answerLeaving(false)
    fireEvent.click(importToggle())
    const send = screen.getByRole('button', { name: 'Create from JSON' })
    expect(send).toBeDisabled()
    expect(send).toHaveAccessibleDescription('Paste or load a schema document first.')

    typeInto(documentInput(), DOCUMENT)
    fireEvent.click(send)

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/imported?tab=schema'))
    expect(sent[0].text).toBe(DOCUMENT)
    expect(confirm).not.toHaveBeenCalled()
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
