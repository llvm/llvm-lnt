import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { suiteRef, type ProjectName, type Suite } from '../../api/suites'
import { apiKey, entry, mockAuth, signIn, TOKEN, unknownToken, whole } from '../../test/auth'
import { BARE_SUITE, PROJECT, SUITE } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  headersOf,
  mockSuites,
  projectList,
  renderPage,
  rowsOf,
  save,
  settle,
  table,
  type SuiteStore,
} from '../../test/page'
import { server } from '../../test/server'

/** A project with a display name, and no suites. */
const SWIFT: ProjectName = { name: 'swift', display_name: 'Swift' }

/** A project whose label sorts it last, though its name sorts it first (AR22). */
const ZED: ProjectName = { name: 'aaa', display_name: 'Zed' }

const PROJECTS = [PROJECT, SWIFT, ZED]

type Failure = ReturnType<typeof errorResponse>

interface Options {
  fail?: () => Failure
  wait?: () => Promise<void>
}

interface Sent {
  method: 'POST' | 'PATCH' | 'DELETE'
  project?: string
  body?: unknown
  auth: string | null
}

/**
 * Answer the project writes (E13) by applying them to `store`, once `wait` resolves, or with
 * `fail`; returns each request's method, project, body and `Authorization`.
 */
function mockWrites(store: SuiteStore, { fail, wait }: Options = {}) {
  const sent: Sent[] = []
  const projectOf = (name: string) => projectList(store.suites, store.projects).items.find(
    (project) => project.name === name,
  )!
  server.use(
    mockApi('post', '/api/projects', async ({ request }) => {
      const body = await request.json()
      sent.push({ method: 'POST', body, auth: request.headers.get('Authorization') })
      await wait?.()
      if (fail) return fail()
      const created = { name: body.name, display_name: body.display_name ?? null }
      store.projects = [...store.projects, created]
      return HttpResponse.json(projectOf(body.name), { status: 201 })
    }),
    mockApi('patch', '/api/projects/{project}', async ({ request, params }) => {
      const body = await request.json()
      const auth = request.headers.get('Authorization')
      sent.push({ method: 'PATCH', project: params.project, body, auth })
      await wait?.()
      if (fail) return fail()
      const old = store.projects.find((project) => project.name === params.project)!
      const changed = {
        name: body.name ?? old.name,
        display_name: body.display_name === undefined ? old.display_name : body.display_name,
      }
      store.projects = store.projects.map((project) => (project === old ? changed : project))
      store.suites = store.suites.map((suite) =>
        (suite as Suite).project.name === old.name ? { ...suite, project: changed } : suite,
      )
      return HttpResponse.json(projectOf(changed.name))
    }),
    mockApi('delete', '/api/projects/{project}', async ({ request, params }) => {
      const auth = request.headers.get('Authorization')
      sent.push({ method: 'DELETE', project: params.project, auth })
      await wait?.()
      if (fail) return fail()
      store.projects = store.projects.filter((project) => project.name !== params.project)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return sent
}

function projectsTable() {
  return table('Projects')
}

/** The row of the project `name`. */
function row(name: string) {
  return screen.getByRole('button', { name: `Delete project ${name}` }).closest('tr')!
}

function form() {
  return screen.getByRole('form', { name: 'New project' })
}

function nameInput() {
  return within(form()).getByRole('textbox', { name: 'Name' })
}

function displayNameInput() {
  return within(form()).getByRole('textbox', { name: 'Display name' })
}

function createButton() {
  return within(form()).getByRole('button', { name: /^(Create project|Creating\.\.\.)$/ })
}

function deleteButton(name: string) {
  return screen.getByRole('button', { name: `Delete project ${name}` })
}

function prompt() {
  return screen.queryByRole('form', { name: 'Confirmation' })
}

/** The names the projects listed in the cache have. */
function cachedProjects(queryClient: QueryClient) {
  return queryClient
    .getQueryData<Schemas['ProjectList']>(queryKeys.projects)
    ?.items.map((project) => project.name)
    .sort()
}

/**
 * The Projects tab, the instance holding `PROJECTS` and llvm's two suites, to a holder of `scope`
 * restricted to `restrictedTo` unless null, or of no token.
 */
async function renderTab({
  scope = 'manage',
  restrictedTo = null,
  url = '/admin?tab=projects',
}: {
  scope?: Parameters<typeof signIn>[0] | null
  restrictedTo?: Parameters<typeof signIn>[1]
  url?: string
} = {}) {
  if (scope !== null) signIn(scope, restrictedTo)
  const store = mockSuites([SUITE, BARE_SUITE], { projects: PROJECTS })
  const rendered = renderPage(url)
  const list = await projectsTable()
  if (scope !== null) {
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Display name of llvm' })).toBeEnabled(),
    )
  }
  return { ...rendered, store, list }
}

describe('the tab', () => {
  it('is kept in the URL, and drops the sort of the API Keys tab', async () => {
    mockSuites()
    renderPage('/admin?tab=projects&sort=name')

    expect(await screen.findByRole('tab', { name: 'Projects' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=projects'))
  })

  it("lists every project in AR22's order, with its suites, to anyone", async () => {
    const { list } = await renderTab({ scope: null })

    expect(headersOf(list)).toEqual(['Name', 'Display name', 'Suites', 'Actions'])
    expect(rowsOf(list)).toEqual([
      'llvmEdit | --Edit | 2 | Delete',
      'swiftEdit | SwiftEdit | 0 | Delete',
      'aaaEdit | ZedEdit | 0 | Delete',
    ])
    const suites = within(list).getByRole('link', { name: '2 suites of llvm' })
    expect(suites).toHaveAttribute('href', '/projects/llvm')
    expect(within(list).getByRole('link', { name: '0 suites of Swift' })).toHaveAttribute(
      'href',
      '/projects/swift',
    )
  })

  it('says when the projects cannot be loaded, and offers to try again', async () => {
    signIn('manage')
    let fail = true
    server.use(
      mockApi('get', '/api/projects', () =>
        fail
          ? errorResponse(500, 'internal', 'Boom.')
          : HttpResponse.json(projectList([], [SWIFT])),
      ),
    )
    renderPage('/admin?tab=projects')

    expect(await screen.findByRole('alert')).toHaveTextContent('Boom.')
    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription('The projects could not be loaded.'),
    )
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(rowsOf(await projectsTable())).toEqual(['swiftEdit | SwiftEdit | 0 | Delete'])
  })
})

describe('gating (AR17)', () => {
  it('disables every change without a token, saying what it needs', async () => {
    await renderTab({ scope: null })

    const instanceWide =
      "Needs an instance-wide API token with the 'manage' scope. Set one in Settings."
    await waitFor(() => expect(createButton()).toHaveAccessibleDescription(instanceWide))
    expect(screen.getByRole('button', { name: 'Edit Name of swift' })).toHaveAttribute(
      'title',
      instanceWide,
    )
    expect(deleteButton('swift')).toHaveAttribute('title', instanceWide)
    expect(deleteButton('swift')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Edit Display name of swift' })).toBeDisabled()
  })

  it('lets a token covering a project in full change its display name only', async () => {
    signIn('manage', [whole('swift')])
    mockSuites([SUITE, BARE_SUITE], { projects: PROJECTS })
    renderPage('/admin?tab=projects')
    await projectsTable()

    const swift = screen.getByRole('button', { name: 'Edit Display name of swift' })
    await waitFor(() => expect(swift).toBeEnabled())
    expect(screen.getByRole('button', { name: 'Edit Display name of llvm' })).toHaveAttribute(
      'title',
      "Needs an API token with the 'manage' scope covering project 'llvm' in full. The token in " +
        "Settings has the 'manage' scope, covering only 'Swift' (all).",
    )
    const instanceWide = /^Needs an instance-wide API token with the 'manage' scope\./
    expect(screen.getByRole('button', { name: 'Edit Name of swift' })).toHaveAttribute(
      'title',
      expect.stringMatching(instanceWide),
    )
    expect(deleteButton('swift')).toHaveAttribute('title', expect.stringMatching(instanceWide))
    expect(createButton()).toHaveAccessibleDescription(instanceWide)
  })
})

describe('gating with a key restricted to a suite', () => {
  it('disables the display names, which need the project covered in full', async () => {
    signIn('manage', [entry('libcxx')])
    mockSuites([SUITE, BARE_SUITE], { projects: PROJECTS })
    renderPage('/admin?tab=projects')
    await projectsTable()

    const edit = screen.getByRole('button', { name: 'Edit Display name of llvm' })
    await waitFor(() =>
      expect(edit).toHaveAttribute(
        'title',
        "Needs an API token with the 'manage' scope covering project 'llvm' in full. The token " +
          "in Settings has the 'manage' scope, covering only 'llvm/libcxx'.",
      ),
    )
    expect(edit).toBeDisabled()
  })
})

describe('creating a project', () => {
  it('checks the name as it is typed, saying why it cannot be created', async () => {
    await renderTab()

    expect(createButton()).toHaveAccessibleDescription('Give the project a name first.')
    fireEvent.change(nameInput(), { target: { value: 'swift' } })
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(createButton()).toHaveAccessibleDescription("There is already a project named 'swift'.")
    fireEvent.change(nameInput(), { target: { value: 'Swift' } })
    expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
    expect(createButton()).toBeDisabled()
    // Too long is refused, rather than cut short.
    fireEvent.change(nameInput(), { target: { value: 'a'.repeat(65) } })
    expect(nameInput()).toHaveValue('a'.repeat(65))
    expect(createButton()).toHaveAccessibleDescription('A name is at most 64 characters long.')
    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    expect(nameInput()).not.toHaveAttribute('aria-invalid')
    expect(createButton()).toBeEnabled()
  })

  it('creates it, adds it to the table, empties the form and focuses the name', async () => {
    const { store, list } = await renderTab()
    const sent = mockWrites(store)

    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    fireEvent.change(displayNameInput(), { target: { value: '  LLDB  ' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(rowsOf(list)).toHaveLength(4))
    expect(rowsOf(list)[0]).toBe('lldbEdit | LLDBEdit | 0 | Delete')
    expect(sent).toEqual([
      { method: 'POST', body: { name: 'lldb', display_name: 'LLDB' }, auth: `Bearer ${TOKEN}` },
    ])
    expect(nameInput()).toHaveValue('')
    expect(displayNameInput()).toHaveValue('')
    expect(nameInput()).toHaveFocus()
    // Without fetching the list again.
    expect(store.requests).toBe(1)
  })

  it('drops what was read from inside the suites of an earlier project of its name', async () => {
    const { store, list, queryClient } = await renderTab()
    mockWrites(store)
    const earlier = [...queryKeys.machines(suiteRef('lldb', 'x')), 'detail', 'm']
    queryClient.setQueryData(earlier, { name: 'm' })

    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(rowsOf(list)).toHaveLength(4))
    expect(queryClient.getQueryData(earlier)).toBeUndefined()
  })

  it('cannot create one until the projects have loaded', async () => {
    signIn('manage')
    const loaded = gate()
    mockSuites([SUITE, BARE_SUITE], { projects: PROJECTS, wait: () => loaded.promise })
    renderPage('/admin?tab=projects')

    await waitFor(() =>
      expect(createButton()).toHaveAccessibleDescription('Loading the projects...'),
    )
    await act(async () => loaded.open())
    await projectsTable()
    expect(createButton()).toHaveAccessibleDescription('Give the project a name first.')
  })

  it('sends an empty display name as null', async () => {
    const { store } = await renderTab()
    const sent = mockWrites(store)

    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    fireEvent.change(displayNameInput(), { target: { value: '   ' } })
    fireEvent.click(createButton())

    await waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0].body).toEqual({ name: 'lldb', display_name: null })
  })

  it('keeps the form on failure, and says why', async () => {
    const { store } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(400, 'validation_error', 'Too long.') })

    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    fireEvent.change(displayNameInput(), { target: { value: 'LLDB' } })
    fireEvent.click(createButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Too long.')
    expect(nameInput()).toHaveValue('lldb')
    expect(displayNameInput()).toHaveValue('LLDB')
    expect(store.requests).toBe(1)
  })

  it('has the name check say so once the name was taken meanwhile', async () => {
    const { store } = await renderTab()
    const sent = mockWrites(store, {
      fail: () => errorResponse(409, 'duplicate', "A project named 'lldb' already exists."),
    })
    fireEvent.change(nameInput(), { target: { value: 'lldb' } })
    // Created elsewhere.
    store.projects = [...store.projects, { name: 'lldb', display_name: null }]

    fireEvent.click(createButton())

    await waitFor(() => expect(nameInput()).toHaveAttribute('aria-invalid', 'true'))
    expect(sent).toHaveLength(1)
    expect(screen.getByRole('alert')).toHaveTextContent('already exists')
  })
})

describe('renaming a project', () => {
  it('checks the name as it is typed, its own name aside', async () => {
    await renderTab()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name of swift' }))
    const input = screen.getByRole('textbox', { name: 'Name of swift' })
    const saveButton = within(row('swift')).getByRole('button', { name: 'Save' })

    fireEvent.change(input, { target: { value: 'llvm' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(saveButton).toHaveAttribute('title', "There is already a project named 'llvm'.")
    fireEvent.change(input, { target: { value: 'Swift' } })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    fireEvent.change(input, { target: { value: 'a'.repeat(65) } })
    expect(input).toHaveValue('a'.repeat(65))
    expect(saveButton).toBeDisabled()
    fireEvent.change(input, { target: { value: '' } })
    expect(saveButton).toHaveAttribute('title', 'A project needs a name.')
    fireEvent.change(input, { target: { value: 'swift' } })
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('sends nothing for its own name, even with whitespace around it', async () => {
    const { store } = await renderTab()
    const sent = mockWrites(store)

    save('Name of swift', '  swift ')

    expect(prompt()).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit Name of swift' })).toHaveFocus()
    expect(sent).toEqual([])
  })

  it('renames it once confirmed, saying what that breaks', async () => {
    const { store, list } = await renderTab()
    const sent = mockWrites(store)

    save('Name of swift', ' apple ')
    expect(prompt()).toHaveTextContent(
      "Rename the project Swift (swift) to apple? Every URL, bookmark and bot that uses the name " +
        "swift for any of the project's suites will get a 404 until it is updated.",
    )
    expect(prompt()).toHaveTextContent('API keys are unaffected.')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(rowsOf(list)[1]).toBe('appleEdit | SwiftEdit | 0 | Delete'))
    expect(sent).toEqual([
      { method: 'PATCH', project: 'swift', body: { name: 'apple' }, auth: `Bearer ${TOKEN}` },
    ])
    expect(within(list).getByRole('link', { name: '0 suites of Swift' })).toHaveAttribute(
      'href',
      '/projects/apple',
    )
  })

  it('sends nothing when the prompt is cancelled', async () => {
    const { store } = await renderTab()
    const sent = mockWrites(store)

    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Name of swift' })).toHaveFocus()
    expect(sent).toEqual([])
  })

  it('forgets what was read under both names, and the API keys, and checks the token', async () => {
    const { store, queryClient } = await renderTab()
    const from = suiteRef('llvm', 'libcxx')
    const to = suiteRef('clang', 'libcxx')
    // What was read from inside its suites under the old name, which a project created later under
    // it must not find, and from inside the suites of an earlier project of the new name.
    queryClient.setQueryData([...queryKeys.machines(from), 'detail', 'm'], { name: 'm' })
    queryClient.setQueryData([...queryKeys.machines(to), 'detail', 'm'], { name: 'old' })
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    mockWrites(store)
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))

    save('Name of llvm', 'clang')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(cachedProjects(queryClient)).toEqual(['aaa', 'clang', 'swift'])
    const cache = queryClient.getQueryCache()
    expect(cache.findAll({ queryKey: queryKeys.projectSuites('llvm') })).toEqual([])
    expect(queryClient.getQueryData([...queryKeys.machines(to), 'detail', 'm'])).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it("focuses the new row's Edit once the token has been checked again", async () => {
    const { store } = await renderTab()
    mockWrites(store)
    const held = gate()
    mockAuth(async () => {
      await held.promise
      return HttpResponse.json({ key: apiKey('manage') })
    })

    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))
    const edit = await screen.findByRole('button', { name: 'Edit Name of apple' })
    expect(edit).toBeDisabled()
    await act(async () => held.open())

    await waitFor(() => expect(edit).toHaveFocus())
  })

  it('focuses the table when the check leaves Edit disabled', async () => {
    const { store, list } = await renderTab()
    mockWrites(store)
    // The key was revoked meanwhile.
    mockAuth(() => unknownToken())

    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(list).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Edit Name of apple' })).toBeDisabled()
  })

  it('leaves the focus where the user put it while the token was checked again', async () => {
    const { store } = await renderTab()
    mockWrites(store)
    const held = gate()
    mockAuth(async () => {
      await held.promise
      return HttpResponse.json({ key: apiKey('manage') })
    })
    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))
    const edit = await screen.findByRole('button', { name: 'Edit Name of apple' })

    nameInput().focus()
    await act(async () => held.open())
    await waitFor(() => expect(edit).toBeEnabled())

    expect(nameInput()).toHaveFocus()
  })

  it('has the name check say so once the name was taken meanwhile', async () => {
    const { store } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(409, 'duplicate', 'Taken.') })

    save('Name of swift', 'apple')
    store.projects = [...store.projects, { name: 'apple', display_name: null }]
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    const input = screen.getByRole('textbox', { name: 'Name of swift' })
    await waitFor(() => expect(input).toHaveAttribute('aria-invalid', 'true'))
    expect(input).toHaveValue('apple')
    expect(within(row('swift')).getByRole('alert')).toHaveTextContent('Taken.')
  })

  it('removes the row of a project deleted meanwhile', async () => {
    const { store, list } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(404, 'not_found', 'No such project.') })

    save('Name of swift', 'apple')
    store.projects = store.projects.filter((project) => project.name !== 'swift')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(rowsOf(list)).toHaveLength(2))
    expect(screen.queryByRole('button', { name: 'Edit Name of swift' })).not.toBeInTheDocument()
  })

  it('says why when the locks could not be taken, without fetching the list again', async () => {
    const { store } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(409, 'retry', 'Busy, try again.') })

    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    expect(await within(row('swift')).findByRole('alert')).toHaveTextContent('Busy, try again.')
    await settle()
    expect(store.requests).toBe(1)
  })
})

describe('renaming a project, racing', () => {
  it('checks the token again even when the user has left the page meanwhile', async () => {
    const { store, queryClient } = await renderTab()
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    const held = gate()
    mockWrites(store, { wait: () => held.promise })
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))
    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))

    fireEvent.click(screen.getByRole('link', { name: '2 suites of llvm' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    await act(async () => held.open())

    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(cachedProjects(queryClient)).toEqual(['aaa', 'apple', 'llvm'])
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('does not bring the old name back from a list fetched before, and asks again', async () => {
    const { list, queryClient } = await renderTab()
    const held = gate()
    // Each list is made when asked for, and sent once `held` opens.
    const refetched = mockSuites([SUITE, BARE_SUITE], {
      projects: PROJECTS,
      wait: () => held.promise,
    })
    mockWrites(refetched)
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    await waitFor(() => expect(refetched.requests).toBe(1))

    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))
    await screen.findByRole('button', { name: 'Edit Name of apple' })
    await waitFor(() => expect(refetched.requests).toBe(2))
    await act(async () => held.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(cachedProjects(queryClient)).toEqual(['aaa', 'apple', 'llvm'])
    expect(within(list).queryByRole('button', { name: 'Edit Name of swift' })).toBeNull()
  })

  it('asks for the list again when it no longer holds the project once renamed', async () => {
    const { store, queryClient } = await renderTab()
    const held = gate()
    mockWrites(store, { wait: () => held.promise })
    save('Name of swift', 'apple')
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'OK' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Saving...' })).toBeVisible())
    // A list fetched meanwhile no longer held it.
    queryClient.setQueryData(queryKeys.projects, projectList([SUITE, BARE_SUITE], [PROJECT, ZED]))
    const requests = store.requests

    await act(async () => held.open())

    await waitFor(() => expect(store.requests).toBe(requests + 1))
    await waitFor(() => expect(cachedProjects(queryClient)).toEqual(['aaa', 'apple', 'llvm']))
  })
})

describe('changing a display name', () => {
  it('saves it without asking, and orders the row by its new label', async () => {
    const { store, list } = await renderTab()
    const sent = mockWrites(store)

    save('Display name of aaa', ' Alpha ')

    expect(prompt()).not.toBeInTheDocument()
    await waitFor(() => expect(rowsOf(list)[0]).toBe('aaaEdit | AlphaEdit | 0 | Delete'))
    expect(sent).toEqual([
      { method: 'PATCH', project: 'aaa', body: { display_name: 'Alpha' }, auth: `Bearer ${TOKEN}` },
    ])
    expect(screen.getByRole('button', { name: 'Edit Display name of aaa' })).toHaveFocus()
  })

  it('clears it when emptied', async () => {
    const { store, list } = await renderTab()
    const sent = mockWrites(store)

    save('Display name of swift', '  ')

    await waitFor(() => expect(rowsOf(list)[1]).toBe('swiftEdit | --Edit | 0 | Delete'))
    expect(sent[0].body).toEqual({ display_name: null })
  })

  it('removes the row of a project deleted meanwhile', async () => {
    const { store, list } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(404, 'not_found', 'No such project.') })

    store.projects = store.projects.filter((project) => project.name !== 'swift')
    save('Display name of swift', 'Swifty')

    await waitFor(() => expect(rowsOf(list)).toHaveLength(2))
  })
})

describe('deleting a project', () => {
  it('is disabled while the project has suites, saying why', async () => {
    await renderTab()

    expect(deleteButton('llvm')).toBeDisabled()
    expect(deleteButton('llvm')).toHaveAttribute(
      'title',
      "The project 'llvm' still has test suites: delete or move them first.",
    )
    expect(deleteButton('swift')).toBeEnabled()
  })

  it('deletes it once confirmed, forgets the API keys, and checks the token', async () => {
    const { store, list, queryClient } = await renderTab()
    const sent = mockWrites(store)
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))

    fireEvent.click(deleteButton('swift'))
    expect(prompt()).toHaveTextContent(
      "Delete the project Swift (swift)? API keys listing the project will lose it, and a key " +
        "left with nothing listed will grant only 'read'.",
    )
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(rowsOf(list)).toHaveLength(2))
    expect(prompt()).not.toBeInTheDocument()
    expect(list).toHaveFocus()
    expect(sent).toEqual([{ method: 'DELETE', project: 'swift', auth: `Bearer ${TOKEN}` }])
    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })

  it('sends nothing when cancelled, and gives the focus back to its button', async () => {
    const { store } = await renderTab()
    const sent = mockWrites(store)

    fireEvent.click(deleteButton('swift'))
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(deleteButton('swift')).toHaveFocus()
    expect(sent).toEqual([])
  })

  it('takes a project deleted meanwhile as deleted', async () => {
    const { store, list } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(404, 'not_found', 'No such project.') })
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))

    fireEvent.click(deleteButton('swift'))
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(rowsOf(list)).toHaveLength(2))
    expect(prompt()).not.toBeInTheDocument()
    expect(list).toHaveFocus()
    await waitFor(() => expect(rechecks).toHaveLength(1))
  })

  it('says why it was refused once suites were created in it, and disables Delete', async () => {
    const { store } = await renderTab()
    mockWrites(store, { fail: () => errorResponse(409, 'conflict', 'It has suites.') })
    store.suites = [...store.suites, { ...BARE_SUITE, project: SWIFT }]

    fireEvent.click(deleteButton('swift'))
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))

    expect(await within(prompt()!).findByRole('alert')).toHaveTextContent('It has suites.')
    await waitFor(() =>
      expect(within(prompt()!).getByRole('button', { name: 'Delete' })).toBeDisabled(),
    )
    expect(deleteButton('swift')).toBeDisabled()
  })

  it('does not show it again when a list fetched before the deletion arrives after', async () => {
    const { list, queryClient } = await renderTab()
    const held = gate()
    // Each list is made when asked for, and sent once `held` opens.
    const refetched = mockSuites([SUITE, BARE_SUITE], {
      projects: PROJECTS,
      wait: () => held.promise,
    })
    mockWrites(refetched)
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects })
    await waitFor(() => expect(refetched.requests).toBe(1))

    fireEvent.click(deleteButton('swift'))
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(rowsOf(list)).toHaveLength(2))
    // The list on its way, which may have held more than the cache, is asked for again.
    await waitFor(() => expect(refetched.requests).toBe(2))
    await act(async () => held.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(rowsOf(list)).toHaveLength(2)
    expect(cachedProjects(queryClient)).toEqual(['aaa', 'llvm'])
  })

  it('closes the prompt once its project is deleted elsewhere, focusing the table', async () => {
    const { store, list, queryClient } = await renderTab()
    fireEvent.click(deleteButton('swift'))
    expect(within(prompt()!).getByRole('button', { name: 'Cancel' })).toHaveFocus()

    store.projects = store.projects.filter((project) => project.name !== 'swift')
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.projects }))

    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(list).toHaveFocus()
  })

  it('leaves the focus where the user put it when the prompt closes so', async () => {
    const { store, queryClient } = await renderTab()
    fireEvent.click(deleteButton('swift'))
    nameInput().focus()

    store.projects = store.projects.filter((project) => project.name !== 'swift')
    await act(() => queryClient.refetchQueries({ queryKey: queryKeys.projects }))

    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    expect(nameInput()).toHaveFocus()
  })

  it("closes the prompt of a project renamed, focusing the project's new name", async () => {
    const { store } = await renderTab()
    mockWrites(store)
    fireEvent.click(deleteButton('swift'))

    save('Name of swift', 'apple')
    const prompts = screen.getAllByRole('form', { name: 'Confirmation' })
    expect(prompts).toHaveLength(2)
    fireEvent.click(within(prompts[1]).getByRole('button', { name: 'OK' }))

    await waitFor(() => expect(prompt()).not.toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Name of apple' })).toHaveFocus(),
    )
  })

  it('checks the token again even when the user has left the page meanwhile', async () => {
    const { store, queryClient } = await renderTab()
    queryClient.setQueryData(queryKeys.apiKeys, { items: [apiKey('manage')] })
    const held = gate()
    mockWrites(store, { wait: () => held.promise })
    const rechecks = mockAuth(() => HttpResponse.json({ key: apiKey('manage') }))
    fireEvent.click(deleteButton('swift'))
    fireEvent.click(within(prompt()!).getByRole('button', { name: 'Delete' }))

    fireEvent.click(screen.getByRole('link', { name: '2 suites of llvm' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm'))
    await act(async () => held.open())

    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    expect(cachedProjects(queryClient)).toEqual(['aaa', 'llvm'])
    expect(queryClient.getQueryData(queryKeys.apiKeys)).toBeUndefined()
  })
})
