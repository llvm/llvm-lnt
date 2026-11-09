import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import type { ApiKey } from '../../api/api-keys'
import type { Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { TOKEN_STORAGE_KEY } from '../../auth/storage-key'
import {
  apiKey,
  changeInAnotherTab,
  entry,
  mockAuth,
  signIn,
  TOKEN,
  unknownToken,
  whole,
} from '../../test/auth'
import { mockClipboard } from '../../test/clipboard'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  headersOf,
  main,
  mockSent,
  mockSuites,
  renderPage,
  rowsOf,
  table,
} from '../../test/page'
import { optionsIn, pickOption, selectButton, toggleOptions } from '../../test/select'
import { BARE_SUITE, PROJECT, SUITE } from '../../test/fixtures'
import { server } from '../../test/server'

/** The key of the token `signIn` stores, among the others. */
const OWN = apiKey('admin', {
  name: 'my-admin',
  created_at: '2026-08-05T10:00:00Z',
  last_used_at: '2026-08-20T08:00:00Z',
})

/** As the API lists them: newest first. */
const KEYS: ApiKey[] = [
  apiKey('triage', {
    prefix: '229d78c5',
    name: 'test-key2',
    created_at: '2026-08-13T03:01:04Z',
    last_used_at: null,
  }),
  apiKey('manage', {
    prefix: '135f502b',
    name: 'test-key',
    restricted_to: [entry('libcxx'), entry('nts')],
    created_at: '2026-08-11T13:04:23Z',
    last_used_at: '2026-08-18T03:49:26Z',
  }),
  OWN,
  apiKey('submit', {
    prefix: '3f0ac112',
    name: 'old-bot',
    restricted_to: [entry('nts')],
    created_at: '2026-07-02T09:12:44Z',
    last_used_at: '2026-08-01T18:20:11Z',
    is_active: false,
  }),
]

const ROWS = [
  '229d78c5 | test-key2 | triage | All | 2026-08-13, 3:01:04 AM | Never | Yes | EditRevoke',
  '135f502b | test-key | manage | llvm › libcxx, llvm › nts | 2026-08-11, 1:04:23 PM | 2026-08-18, 3:49:26 AM | Yes | EditRevoke',
  'aaaaaaaa | my-admin | admin | All | 2026-08-05, 10:00:00 AM | 2026-08-20, 8:00:00 AM | Yes | EditRevoke',
  '3f0ac112 | old-bot | submit | llvm › nts | 2026-07-02, 9:12:44 AM | 2026-08-01, 6:20:11 PM | No | ',
]

/** The keys the mocked API holds, as it lists them, and the `Authorization` of each listing. */
interface KeyStore {
  keys: ApiKey[]
  requests: string[]
}

/**
 * Answer `GET /admin/api-keys` with the keys the returned store holds when the request arrives,
 * `keys` at first, once `wait` resolves.
 */
function mockKeys({ keys = KEYS, wait }: { keys?: ApiKey[]; wait?: () => Promise<void> } = {}) {
  const store: KeyStore = { keys: [...keys], requests: [] }
  server.use(
    mockApi('get', '/api/admin/api-keys', async ({ request }) => {
      store.requests.push(request.headers.get('Authorization') ?? '')
      const items = [...store.keys]
      await wait?.()
      return HttpResponse.json({ items })
    }),
  )
  return store
}

/** The key the mocked API creates, and its creation's answer, with the token. */
const CREATED_KEY = apiKey('submit', {
  prefix: '5e5e5e5e',
  name: 'ci-bot',
  created_at: '2026-08-21T12:00:00Z',
})
const CREATED: Schemas['ApiKeyCreated'] = { ...CREATED_KEY, token: '5e5e5e5e' + 'f'.repeat(56) }

const CREATED_ROW =
  '5e5e5e5e | ci-bot | submit | All | 2026-08-21, 12:00:00 PM | Never | Yes | EditRevoke'

type Failure = ReturnType<typeof errorResponse>

/**
 * Answer `POST /admin/api-keys` by storing `CREATED` in `store` and returning it once `wait`
 * resolves, or with `fail`; returns what each request sent.
 */
function mockCreate(
  store: KeyStore,
  { fail, wait }: { fail?: () => Failure; wait?: () => Promise<void> } = {},
) {
  return mockSent('post', '/api/admin/api-keys', async () => {
    if (fail) return fail()
    store.keys.unshift(CREATED_KEY)
    await wait?.()
    return HttpResponse.json(CREATED, { status: 201 })
  })
}

/**
 * Answer `DELETE /admin/api-keys/{prefix}` by marking the key inactive in `store`, or with `fail`;
 * returns the prefixes it was sent.
 */
function mockRevoke(store: KeyStore, fail?: () => Failure) {
  const prefixes: string[] = []
  server.use(
    mockApi('delete', '/api/admin/api-keys/{prefix}', ({ params }) => {
      prefixes.push(params.prefix)
      if (fail) return fail()
      store.keys = store.keys.map((key) =>
        key.prefix === params.prefix ? { ...key, is_active: false } : key,
      )
      return new HttpResponse(null, { status: 204 })
    }),
  )
  return prefixes
}

/** Have `GET /api/auth` accept the token as an admin key's, once `wait` resolves. */
function mockSlowCheck(wait: () => Promise<void>) {
  return mockAuth(async () => {
    await wait()
    return HttpResponse.json({ key: OWN })
  })
}

function keysTable() {
  return table('API keys')
}

function createForm() {
  return screen.getByRole('form', { name: 'Create API Key' })
}

function createButton() {
  return within(createForm()).getByRole('button', { name: /Create key|Creating/ })
}

function nameInput() {
  return within(createForm()).getByRole('textbox', { name: 'Name' })
}

function createKey(name: string) {
  fireEvent.change(nameInput(), { target: { value: name } })
  fireEvent.click(createButton())
}

/** The dropdown of the projects and suites a new key is restricted to (AD1). */
function suitesButton() {
  return selectButton('Projects and suites to restrict to', createForm())
}

/** Open the list of the projects and suites to restrict a new `manage` key to (AD1). */
async function openSuites() {
  await pickOption('Scope', 'manage', createForm())
  fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
  const user = userEvent.setup()
  const button = suitesButton()
  await user.click(button)
  return { user, button, list: await screen.findByRole('listbox') }
}

/** The banner showing the token of the key just created, if it shows. */
function createdKey() {
  return screen.queryByRole('region', { name: 'Created key' })
}

function findCreatedKey() {
  return screen.findByRole('region', { name: 'Created key' })
}

function revokeButton(prefix: string) {
  return screen.getByRole('button', { name: `Revoke key ${prefix}` })
}

function prompt() {
  return screen.queryByRole('form', { name: 'Confirmation' })!
}

/**
 * Sign in as `OWN`'s holder, whose key `signIn` accepts the token as (they share their prefix),
 * and show the keys, as the API lists `keys`, at `url`.
 */
async function renderKeys({ url = '/admin', keys }: { url?: string; keys?: ApiKey[] } = {}) {
  const checks = signIn('admin')
  const store = mockKeys({ keys })
  const rendered = renderPage(url)
  const list = await keysTable()
  return { ...rendered, list, store, checks }
}

// The form creating a key lists the projects and their suites (AD1).
beforeEach(() => {
  mockSuites()
})

describe('the Admin page', () => {
  it('opens on its API Keys tab, and keeps the other in the URL', async () => {
    renderPage('/admin')

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Admin')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'API Keys',
      'Projects',
    ])
    expect(screen.getByRole('tab', { name: 'API Keys' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=projects'))
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
  })

  it('drops a tab it does not have', async () => {
    renderPage('/admin?tab=nope')

    await waitFor(() => expect(currentUrl()).toBe('/admin'))
    expect(await screen.findByRole('tab', { name: 'API Keys' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })
})

describe('the API Keys tab', () => {
  it('says that it needs an admin token without one, and asks for no keys', async () => {
    const { requests } = mockKeys()
    renderPage('/admin')

    expect((await main().findByRole('alert')).textContent).toBe(
      "Permission denied. Needs an API token with the 'admin' scope. Set one in Settings.",
    )
    expect(screen.queryByRole('form', { name: 'Create API Key' })).not.toBeInTheDocument()
    expect(requests).toEqual([])
  })

  it.each(['submit', 'manage'] as const)(
    'says that permission is denied with a %s token',
    async (scope) => {
      signIn(scope)
      const { requests } = mockKeys()
      renderPage('/admin')

      expect(await main().findByRole('alert')).toHaveTextContent(
        `Permission denied. Needs an API token with the 'admin' scope. The token in Settings has ` +
          `the '${scope}' scope.`,
      )
      expect(requests).toEqual([])
    },
  )

  it('says that permission is denied when the token is not valid', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(unknownToken)
    renderPage('/admin')

    expect(await main().findByRole('alert')).toHaveTextContent(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings is " +
        'not valid.',
    )
  })

  it('says that the token is being checked rather than deny permission', async () => {
    const check = gate()
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockSlowCheck(() => check.promise)
    mockKeys()
    renderPage('/admin')

    expect(await main().findByRole('status')).toHaveTextContent('Checking the API token...')
    expect(main().queryByRole('alert')).not.toBeInTheDocument()

    await act(async () => check.open())
    expect(rowsOf(await keysTable())).toEqual(ROWS)
    expect(main().queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says that a token entered after a denial is being checked, rather than deny it', async () => {
    mockKeys()
    renderPage('/admin')
    await main().findByRole('alert')
    const check = gate()
    mockSlowCheck(() => check.promise)

    act(() => changeInAnotherTab(TOKEN_STORAGE_KEY, TOKEN))

    expect(await main().findByRole('status')).toHaveTextContent('Checking the API token...')
    expect(main().queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => check.open())
    expect(rowsOf(await keysTable())).toEqual(ROWS)
  })

  it('lists every key with the token, newest first, revoked ones last, muted, without Revoke', async () => {
    const { list, store } = await renderKeys()

    expect(rowsOf(list)).toEqual(ROWS)
    const rows = within(list).getAllByRole('row').slice(1)
    expect(rows.map((row) => row.classList.contains('revoked'))).toEqual([
      false,
      false,
      false,
      true,
    ])
    expect(headersOf(list)).toEqual([
      'Prefix',
      'Name',
      'Scope',
      'Covers',
      'Created▼',
      'Last Used',
      'Active',
      'Actions',
    ])
    expect(screen.getByRole('columnheader', { name: /Created/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    )
    expect(screen.getByRole('columnheader', { name: 'Name' })).not.toHaveAttribute('aria-sort')
    expect(store.requests).toEqual([`Bearer ${TOKEN}`])
  })

  it('says when there are no keys', async () => {
    const { list } = await renderKeys({ keys: [] })

    expect(rowsOf(list)).toEqual(['No API keys yet.'])
  })

  it('shows why the keys could not be listed, and lists them on retry', async () => {
    signIn('admin')
    server.use(
      mockApi('get', '/api/admin/api-keys', () =>
        errorResponse(500, 'internal_error', 'The database is down.'),
      ),
    )
    renderPage('/admin')

    expect(await main().findByRole('alert')).toHaveTextContent('The database is down.')
    mockKeys()
    fireEvent.click(main().getByRole('button', { name: 'Retry' }))
    expect(rowsOf(await keysTable())).toEqual(ROWS)
  })
})

describe('sorting the keys', () => {
  const prefixes = (list: HTMLElement) => rowsOf(list).map((row) => row.split(' | ')[0])

  it('sorts by Last Used, the keys never used last in both directions, bar the revoked', async () => {
    const { list } = await renderKeys()

    fireEvent.click(within(list).getByRole('button', { name: 'Last Used' }))
    expect(prefixes(list)).toEqual(['135f502b', 'aaaaaaaa', '229d78c5', '3f0ac112'])
    expect(screen.getByRole('columnheader', { name: /Last Used/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: 'Created' })).not.toHaveAttribute('aria-sort')

    fireEvent.click(within(list).getByRole('button', { name: /Last Used/ }))
    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '229d78c5', '3f0ac112'])
  })

  it('sorts scopes from the lowest to the highest, and the other columns by value', async () => {
    const { list, store } = await renderKeys()

    // The revoked key, old-bot, comes last whatever the sort.
    fireEvent.click(within(list).getByRole('button', { name: 'Scope' }))
    expect(prefixes(list)).toEqual(['229d78c5', '135f502b', 'aaaaaaaa', '3f0ac112'])

    // my-admin, test-key, test-key2.
    fireEvent.click(within(list).getByRole('button', { name: 'Name' }))
    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '229d78c5', '3f0ac112'])

    fireEvent.click(within(list).getByRole('button', { name: 'Prefix' }))
    expect(prefixes(list)).toEqual(['135f502b', '229d78c5', 'aaaaaaaa', '3f0ac112'])

    fireEvent.click(within(list).getByRole('button', { name: 'Created' }))
    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '229d78c5', '3f0ac112'])

    // All first, then by the suites' names in order.
    fireEvent.click(within(list).getByRole('button', { name: 'Covers' }))
    expect(prefixes(list)).toEqual(['229d78c5', 'aaaaaaaa', '135f502b', '3f0ac112'])
    await waitFor(() => expect(currentUrl()).toBe('/admin?sort=restricted_to'))
    fireEvent.click(within(list).getByRole('button', { name: /Covers/ }))
    expect(prefixes(list)).toEqual(['135f502b', '229d78c5', 'aaaaaaaa', '3f0ac112'])

    // Which would change nothing.
    expect(within(list).queryByRole('button', { name: 'Active' })).not.toBeInTheDocument()

    // Sorting asks the API for nothing.
    expect(store.requests).toHaveLength(1)
  })

  it('shows Nothing for a key whose entries were all deleted, and sorts it last', async () => {
    const orphan = apiKey('submit', {
      prefix: '7d1e40aa',
      name: 'swift-bot',
      restricted_to: [],
      created_at: '2026-08-02T16:40:10Z',
    })
    const { list } = await renderKeys({ keys: [...KEYS.slice(0, 3), orphan, KEYS[3]] })

    expect(rowsOf(list)[3]).toBe(
      '7d1e40aa | swift-bot | submit | Nothing | 2026-08-02, 4:40:10 PM | Never | Yes | EditRevoke',
    )
    expect(within(list).getByText('Nothing')).toHaveAttribute(
      'title',
      'What it was restricted to has been deleted, so it can only read.',
    )

    fireEvent.click(within(list).getByRole('button', { name: 'Covers' }))
    // Among the active keys: it is not revoked, and still authenticates.
    expect(prefixes(list)).toEqual(['229d78c5', 'aaaaaaaa', '135f502b', '7d1e40aa', '3f0ac112'])
    fireEvent.click(within(list).getByRole('button', { name: /Covers/ }))
    expect(prefixes(list)).toEqual(['7d1e40aa', '135f502b', '229d78c5', 'aaaaaaaa', '3f0ac112'])
  })

  it('names the suites of a key by their labels, in the order they are listed in (AR22)', async () => {
    // Listed first, though both its name and its label would sort it last.
    mockSuites([{ ...SUITE, display_name: 'zeta' }, BARE_SUITE])
    const both = apiKey('triage', {
      prefix: 'bbbbbbbb',
      restricted_to: [entry('libcxx'), entry('nts')],
    })
    const libcxx = apiKey('triage', { prefix: 'cccccccc', restricted_to: [entry('libcxx')] })
    const nts = apiKey('triage', { prefix: 'dddddddd', restricted_to: [entry('nts')] })
    const { list } = await renderKeys({ keys: [libcxx, both, nts] })

    await waitFor(() => expect(rowsOf(list)[0].split(' | ')[3]).toBe('llvm › zeta'))
    expect(rowsOf(list)[1].split(' | ')[3]).toBe('llvm › zeta, llvm › nts')

    fireEvent.click(within(list).getByRole('button', { name: 'Covers' }))
    expect(prefixes(list)).toEqual(['cccccccc', 'bbbbbbbb', 'dddddddd'])
  })

  it('shows a whole project by its label followed by (all), before its suites', async () => {
    const llvm = { ...PROJECT, display_name: 'LLVM' }
    mockSuites([{ ...SUITE, project: llvm }], {
      projects: [llvm, { name: 'swift', display_name: null }],
    })
    const projects = apiKey('manage', {
      prefix: 'bbbbbbbb',
      restricted_to: [whole('swift'), entry('libcxx'), whole('llvm')],
    })
    const suite = apiKey('manage', { prefix: 'cccccccc', restricted_to: [entry('libcxx')] })
    const { list } = await renderKeys({ keys: [suite, projects] })

    await waitFor(() =>
      expect(rowsOf(list)[1].split(' | ')[3]).toBe('LLVM (all), LLVM › libcxx, swift (all)'),
    )

    // A whole project before the suites of that project.
    fireEvent.click(within(list).getByRole('button', { name: 'Covers' }))
    expect(prefixes(list)).toEqual(['bbbbbbbb', 'cccccccc'])
  })

  it("names suites of several projects by full labels, a project's together (AR22)", async () => {
    // Both labelled 'LLVM', so that 'LLVM › beta' would come between the others by full label.
    const extra = { name: 'extra', display_name: 'LLVM' }
    const llvm = { ...PROJECT, display_name: 'LLVM' }
    mockSuites(
      [
        { ...SUITE, project: llvm, name: 'alpha' },
        { ...BARE_SUITE, project: extra, name: 'beta' },
        { ...BARE_SUITE, project: llvm, name: 'zeta' },
      ],
      { projects: [llvm, extra] },
    )
    const key = apiKey('triage', {
      prefix: 'bbbbbbbb',
      restricted_to: [
        { project: 'extra', suite: 'beta' },
        { project: 'llvm', suite: 'alpha' },
        { project: 'llvm', suite: 'zeta' },
      ],
    })
    const { list } = await renderKeys({ keys: [key] })

    // By project, then by suite, rather than by the full labels.
    await waitFor(() =>
      expect(rowsOf(list)[0].split(' | ')[3]).toBe('LLVM › alpha, LLVM › zeta, LLVM › beta'),
    )
  })

  it('keeps the sort in the URL, leaving out the default one', async () => {
    const { list } = await renderKeys()
    expect(currentUrl()).toBe('/admin')

    fireEvent.click(within(list).getByRole('button', { name: 'Last Used' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?sort=last_used_at'))
    fireEvent.click(within(list).getByRole('button', { name: /Last Used/ }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?sort=-last_used_at'))

    fireEvent.click(within(list).getByRole('button', { name: 'Created' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?sort=created_at'))
    fireEvent.click(within(list).getByRole('button', { name: /Created/ }))
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
  })

  it('sorts as the URL says', async () => {
    const { list } = await renderKeys({ url: '/admin?sort=-last_used_at' })

    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '229d78c5', '3f0ac112'])
  })

  it.each(['created', '-nope', 'revoke', 'is_active'])(
    'drops the sort %s, which it cannot use',
    async (sort) => {
      const { list } = await renderKeys({ url: `/admin?sort=${sort}` })

      expect(rowsOf(list)).toEqual(ROWS)
      await waitFor(() => expect(currentUrl()).toBe('/admin'))
    },
  )

  it('drops the sort on leaving the tab', async () => {
    renderPage('/admin?sort=name')

    fireEvent.click(await screen.findByRole('tab', { name: 'Projects' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=projects'))
  })

  it('drops the sort from the URL of the Projects tab', async () => {
    renderPage('/admin?tab=projects&sort=name')

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=projects'))
  })
})

describe('creating a key', () => {
  it('creates a key of the name and scope given, and shows its token once', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAccessibleDescription('Give the key a name first.')
    // From the lowest scope a key can have: none has 'read' (I5).
    expect(selectButton('Scope', createForm())).toHaveTextContent('submit')
    const user = userEvent.setup()
    await user.click(selectButton('Scope', createForm()))
    expect(optionsIn(await screen.findByRole('listbox'))).toEqual([
      'submit',
      'triage',
      'manage',
      'admin',
    ])
    await user.click(screen.getByRole('option', { name: 'triage' }))

    fireEvent.change(nameInput(), { target: { value: ' ci-bot ' } })
    fireEvent.click(createButton())

    const created = await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'ci-bot', scope: 'triage', restricted_to: null },
    ])
    expect(created).toHaveTextContent(
      'Key ci-bot created. Copy the token now — it will not be shown again:',
    )
    expect(created).toHaveTextContent(CREATED.token)
    expect(nameInput()).toHaveValue('')
    // From the button that is now disabled, to what to do with the token, and why.
    const copy = within(created).getByRole('button', { name: 'Copy to clipboard' })
    expect(copy).toHaveFocus()
    expect(copy).toHaveAccessibleDescription(/it will not be shown again/)

    // The keys are asked for again, and the new one heads them.
    await waitFor(async () => expect(rowsOf(await keysTable())).toEqual([CREATED_ROW, ...ROWS]))
    expect(store.requests).toHaveLength(2)
  })

  it('restricts a key to the suites checked, once one is', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    const form = within(createForm())
    const all = form.getByRole('radio', { name: 'Everything (instance-wide)' })
    const only = form.getByRole('radio', { name: 'Only these:' })
    expect(all).toBeChecked()

    fireEvent.change(nameInput(), { target: { value: 'ci-bot' } })
    await pickOption('Scope', 'triage', createForm())
    // The dropdown can be used only once "Only these:" is chosen.
    expect(suitesButton()).toBeDisabled()
    fireEvent.click(only)
    expect(suitesButton()).toBeEnabled()
    expect(suitesButton()).toHaveTextContent('Select projects or suites')
    expect(createButton()).toHaveAccessibleDescription('Pick at least one project or suite.')

    await toggleOptions('Projects and suites to restrict to', ['llvm › nts'], createForm())
    expect(suitesButton()).toHaveTextContent('llvm › nts')
    fireEvent.click(createButton())

    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'ci-bot', scope: 'triage', restricted_to: [entry('nts')] },
    ])
  })

  it('lists the projects and their suites with a checkbox each, operated from the keyboard', async () => {
    mockSuites([SUITE, BARE_SUITE, { ...BARE_SUITE, name: 'zorg' }])
    await renderKeys()
    await pickOption('Scope', 'submit', createForm())
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
    const user = userEvent.setup()
    const button = suitesButton()
    expect(button).toBeEnabled()

    button.focus()
    await user.keyboard('{ArrowDown}')
    const list = await screen.findByRole('listbox')
    expect(list).toHaveAttribute('aria-multiselectable', 'true')
    // Each suite below its project, by its own label, and by its full label to assistive technology.
    const options = within(list).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['llvm', 'libcxx', 'nts', 'zorg'])
    expect(options.map((option) => option.getAttribute('aria-label'))).toEqual([
      null,
      'llvm › libcxx',
      'llvm › nts',
      'llvm › zorg',
    ])
    // Space checks the option focused, and the list stays open for more.
    await user.keyboard('{ArrowDown} ')
    await user.keyboard('{ArrowDown} ')
    expect(within(list).getByRole('option', { name: 'llvm › nts' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    // Each option shows a checkbox, hidden from assistive technology, which has the option's state.
    expect(within(list).queryAllByRole('checkbox')).toHaveLength(0)
    const boxes = within(list).getAllByRole<HTMLInputElement>('checkbox', { hidden: true })
    expect(boxes.map((box) => box.checked)).toEqual([false, true, true, false])
    expect(button).toHaveTextContent('llvm › libcxx, llvm › nts')
    await user.keyboard('{ArrowDown} ')
    // Too many to name.
    expect(button).toHaveTextContent('3 selected')

    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull())
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('restricts a key to a whole project checked, listing its suites as covered', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    const { user, button, list } = await openSuites()
    // A suite checked first is unchecked once its project is: the project covers it.
    await user.click(within(list).getByRole('option', { name: 'llvm › nts' }))
    await user.click(within(list).getByRole('option', { name: 'llvm' }))

    // The project says nothing more once checked: its suites listed as covered say it.
    const project = within(list).getByRole('option', { name: 'llvm' })
    expect(project).toHaveAttribute('aria-selected', 'true')
    // Its suites are listed as covered, and cannot be checked.
    const covered = within(list).getAllByRole('option').slice(1)
    expect(covered.map((option) => option.getAttribute('aria-label'))).toEqual([
      'llvm › libcxx, covered by llvm',
      'llvm › nts, covered by llvm',
    ])
    for (const option of covered) {
      expect(option).toHaveAttribute('aria-disabled', 'true')
      expect(option).toHaveAttribute('aria-selected', 'false')
    }
    expect(button).toHaveTextContent('llvm (all)')
    await user.click(covered[1])
    expect(covered[1]).toHaveAttribute('aria-selected', 'false')
    expect(button).toHaveTextContent('llvm (all)')
    await user.keyboard('{Escape}')
    createKey('maintainer')

    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'maintainer', scope: 'manage', restricted_to: [{ project: 'llvm', suite: null }] },
    ])
  })

  it('lists the suites of a project unchecked again, unchecked', async () => {
    await renderKeys()
    const { user, button, list } = await openSuites()
    await user.click(within(list).getByRole('option', { name: 'llvm › nts' }))
    await user.click(within(list).getByRole('option', { name: 'llvm' }))

    await user.click(within(list).getByRole('option', { name: 'llvm' }))

    // nts, checked before the project was, is not checked again.
    for (const option of within(list).getAllByRole('option')) {
      expect(option).toHaveAttribute('aria-selected', 'false')
      expect(option).not.toHaveAttribute('aria-disabled')
    }
    expect(button).toHaveTextContent('Select projects or suites')
  })

  it('skips the suites a project checked covers when moving with the arrow keys', async () => {
    mockSuites([SUITE, BARE_SUITE, { ...SUITE, project: { name: 'swift', display_name: null } }])
    await renderKeys()
    await pickOption('Scope', 'manage', createForm())
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
    const user = userEvent.setup()
    suitesButton().focus()
    await user.keyboard('{ArrowDown}')
    const list = await screen.findByRole('listbox')
    const project = within(list).getByRole('option', { name: 'llvm' })
    await waitFor(() => expect(project).toHaveFocus())

    await user.keyboard(' ')
    await user.keyboard('{ArrowDown}')
    expect(within(list).getByRole('option', { name: 'swift' })).toHaveFocus()
    await user.keyboard('{ArrowUp}')
    expect(project).toHaveFocus()
  })

  it('checks nothing more for a selection of everything', async () => {
    await renderKeys()
    const { user, button, list } = await openSuites()
    await user.click(within(list).getByRole('option', { name: 'llvm › nts' }))

    // Selecting everything, which React Aria's Select ignores, checks nothing more: there is no
    // way to check every option at once (AD1).
    await user.keyboard('{Control>}a{/Control}')
    expect(button).toHaveTextContent(/^llvm › nts▾$/)
  })

  it('lists a project without suites, saying so, and what it covers once checked', async () => {
    mockSuites([SUITE], { projects: [PROJECT, { name: 'swift', display_name: null }] })
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    await pickOption('Scope', 'submit', createForm())
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))

    const user = userEvent.setup()
    await user.click(suitesButton())
    await user.click(await screen.findByRole('option', { name: 'swift (no suites)' }))
    // Still saying that it has none (AR22).
    expect(screen.getByRole('option', { name: 'swift (no suites)' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    await user.keyboard('{Escape}')
    expect(suitesButton()).toHaveTextContent('swift (all)')
    createKey('swift-bot')

    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'swift-bot', scope: 'submit', restricted_to: [{ project: 'swift', suite: null }] },
    ])
  })

  it('goes back to everything for a scope that cannot be restricted', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    const form = within(createForm())
    await pickOption('Scope', 'manage', createForm())
    fireEvent.click(form.getByRole('radio', { name: 'Only these:' }))
    await toggleOptions('Projects and suites to restrict to', ['llvm › libcxx'], createForm())

    await pickOption('Scope', 'admin', createForm())

    expect(form.getByRole('radio', { name: 'Everything (instance-wide)' })).toBeChecked()
    expect(form.getByRole('radio', { name: 'Only these:' })).toBeDisabled()
    expect(form.getByRole('radio', { name: 'Only these:' })).toHaveAccessibleDescription(
      "Only 'submit', 'triage' and 'manage' keys can be restricted.",
    )
    // For good: a scope that can be restricted again finds "Everything" still chosen, and what
    // was checked kept for "Only these:".
    await pickOption('Scope', 'triage', createForm())
    expect(form.getByRole('radio', { name: 'Everything (instance-wide)' })).toBeChecked()
    expect(suitesButton()).toBeDisabled()
    expect(suitesButton()).toHaveTextContent('llvm › libcxx')

    await pickOption('Scope', 'admin', createForm())
    createKey('root')
    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'root', scope: 'admin', restricted_to: null },
    ])
  })

  it('sends only the suites checked that are still listed', async () => {
    const { store, queryClient } = await renderKeys()
    const sent = mockCreate(store)
    await pickOption('Scope', 'submit', createForm())
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
    await toggleOptions(
      'Projects and suites to restrict to',
      ['llvm › libcxx', 'llvm › nts'],
      createForm(),
    )

    // nts is deleted meanwhile.
    const suites = mockSuites([SUITE])
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.projects }))
    await waitFor(() => expect(suitesButton()).not.toHaveTextContent('llvm › nts'))
    expect(suites.requests).toBe(1)
    createKey('ci-bot')

    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'ci-bot', scope: 'submit', restricted_to: [entry('libcxx')] },
    ])
  })

  it('drops a whole project checked once it is deleted, which leaves nothing checked', async () => {
    const swift = { name: 'swift', display_name: null }
    mockSuites([SUITE], { projects: [PROJECT, swift] })
    const { queryClient } = await renderKeys()
    fireEvent.change(nameInput(), { target: { value: 'swift-bot' } })
    await pickOption('Scope', 'submit', createForm())
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
    await toggleOptions('Projects and suites to restrict to', ['swift (no suites)'], createForm())
    expect(suitesButton()).toHaveTextContent('swift (all)')

    // swift is deleted meanwhile.
    mockSuites([SUITE], { projects: [PROJECT] })
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.projects }))

    await waitFor(() => expect(suitesButton()).toHaveTextContent('Select projects or suites'))
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAccessibleDescription('Pick at least one project or suite.')
  })

  it('keeps "Only these:" chosen once there are no projects any more, asking for one', async () => {
    const suites = mockSuites()
    const { queryClient } = await renderKeys()
    fireEvent.change(nameInput(), { target: { value: 'ci-bot' } })
    fireEvent.click(within(createForm()).getByRole('radio', { name: 'Only these:' }))
    await toggleOptions('Projects and suites to restrict to', ['llvm › nts'], createForm())

    // Deleted elsewhere: the list says so once fetched again.
    suites.suites = []
    suites.projects = []
    await act(() => queryClient.invalidateQueries({ queryKey: queryKeys.projects }))

    const only = within(createForm()).getByRole('radio', { name: 'Only these:' })
    await waitFor(() => expect(only).toBeDisabled())
    expect(only).toBeChecked()
    expect(createButton()).toHaveAccessibleDescription('Pick at least one project or suite.')
  })

  it('creates an instance-wide key while the suites cannot be listed', async () => {
    const failure = () => errorResponse(500, 'internal_error', 'The server failed')
    server.use(mockApi('get', '/api/projects', failure))
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    const form = within(createForm())
    await pickOption('Scope', 'submit', createForm())

    expect(await form.findByRole('alert')).toHaveTextContent(
      'The projects could not be loaded: The server failed',
    )
    expect(form.getByRole('radio', { name: 'Only these:' })).toBeDisabled()
    createKey('ci-bot')
    await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([
      { name: 'ci-bot', scope: 'submit', restricted_to: null },
    ])

    mockSuites()
    fireEvent.click(form.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(form.getByRole('radio', { name: 'Only these:' })).toBeEnabled())
  })

  it('copies the token to the clipboard', async () => {
    const { store } = await renderKeys()
    mockCreate(store)
    const writeText = mockClipboard()
    createKey('ci-bot')
    const created = await findCreatedKey()

    fireEvent.click(within(created).getByRole('button', { name: 'Copy to clipboard' }))

    await waitFor(() => expect(within(created).getByRole('status')).toHaveTextContent('Copied.'))
    expect(writeText).toHaveBeenCalledWith(CREATED.token)
  })

  it('keeps the token out of every cache once the user leaves the tab', async () => {
    const { queryClient, store } = await renderKeys()
    mockSuites()
    mockCreate(store)
    createKey('ci-bot')
    await findCreatedKey()
    const cached = () =>
      JSON.stringify([
        queryClient.getQueryCache().getAll().map((query) => query.state.data),
        queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data),
      ])

    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }))
    await waitFor(() => expect(cached()).not.toContain(CREATED.token))
    fireEvent.click(screen.getByRole('tab', { name: 'API Keys' }))
    await keysTable()
    expect(createdKey()).not.toBeInTheDocument()
  })

  it('shows why a key could not be created, and keeps the form as it was', async () => {
    const { store } = await renderKeys()
    mockCreate(store, {
      fail: () => errorResponse(400, 'invalid_request', 'The name is too long.'),
    })

    createKey('ci-bot')

    expect(await main().findByRole('alert')).toHaveTextContent('The name is too long.')
    expect(nameInput()).toHaveValue('ci-bot')
    expect(createdKey()).not.toBeInTheDocument()
  })

  it("stops showing a key's token once another is asked for, even if that fails", async () => {
    const { store } = await renderKeys()
    mockCreate(store)
    createKey('ci-bot')
    await findCreatedKey()
    mockCreate(store, {
      fail: () => errorResponse(500, 'internal_error', 'The database is down.'),
    })

    createKey('other')

    expect(await main().findByRole('alert')).toHaveTextContent('The database is down.')
    expect(createdKey()).not.toBeInTheDocument()
  })

  it('keeps a name typed while the key is being created', async () => {
    const { store } = await renderKeys()
    const creation = gate()
    mockCreate(store, { wait: () => creation.promise })
    createKey('ci-bot')
    await waitFor(() => expect(createButton()).toHaveTextContent('Creating...'))

    fireEvent.change(nameInput(), { target: { value: 'next-bot' } })
    await act(async () => creation.open())

    await findCreatedKey()
    expect(nameInput()).toHaveValue('next-bot')
  })

  it('creates nothing without a name', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    fireEvent.change(nameInput(), { target: { value: '   ' } })

    fireEvent.submit(createForm())

    expect(createButton()).toBeDisabled()
    expect(sent).toEqual([])
  })

  it('limits the name to the length the API accepts', async () => {
    await renderKeys()

    expect(nameInput()).toHaveAttribute('maxLength', '256')
  })

  it('shows the key created while the keys were on their way, without waiting for them', async () => {
    signIn('admin')
    const list = gate()
    // The first list leaves the server before the key is created.
    const store = mockKeys({ wait: () => list.promise })
    mockCreate(store)
    renderPage('/admin')
    await waitFor(() => expect(store.requests).toHaveLength(1))
    await waitFor(() => expect(createButton()).toHaveAccessibleDescription(/name first/))

    createKey('ci-bot')
    await findCreatedKey()
    await act(async () => list.open())

    await waitFor(async () => expect(rowsOf(await keysTable())).toEqual([CREATED_ROW, ...ROWS]))
    expect(store.requests).toHaveLength(2)
  })

  it('keeps the token shown, and the sort, while the token is checked again', async () => {
    const { store } = await renderKeys()
    mockCreate(store)
    createKey('ci-bot')
    await findCreatedKey()
    fireEvent.click(within(await keysTable()).getByRole('button', { name: 'Name' }))
    const check = gate()
    const rechecks = mockSlowCheck(() => check.promise)

    // The token is entered again, in another tab say.
    act(() => changeInAnotherTab(TOKEN_STORAGE_KEY, TOKEN))

    await waitFor(() => expect(rechecks).toHaveLength(1))
    expect(createdKey()).toHaveTextContent(CREATED.token)
    // Meanwhile no token would be sent, so nothing that needs one can be done.
    await waitFor(() => expect(revokeButton('135f502b')).toBeDisabled())
    expect(createButton()).toHaveAccessibleDescription(/still being checked/)
    await act(async () => check.open())
    expect(createdKey()).toHaveTextContent(CREATED.token)
    await waitFor(() => expect(revokeButton('135f502b')).toBeEnabled())
    expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
  })
})

describe('revoking a key', () => {
  it('asks first, then moves the row among the revoked keys, without its Revoke button', async () => {
    const { list, store, checks } = await renderKeys()
    const prefixes = mockRevoke(store)

    fireEvent.click(revokeButton('135f502b'))
    expect(prompt()).toHaveTextContent('Revoke the key test-key (135f502b)?')
    expect(prompt()).not.toHaveTextContent('Settings')
    // Nothing to type: revoking a key destroys no data (AR16).
    expect(within(prompt()).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(prompt()).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(within(list).getByText('135f502b').closest('tr')).toHaveClass(/confirming/)
    expect(prefixes).toEqual([])

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(prompt()).toBeNull())
    expect(prefixes).toEqual(['135f502b'])
    // Below every active key, still newest first.
    expect(rowsOf(list)[2]).toBe(
      '135f502b | test-key | manage | llvm › libcxx, llvm › nts | 2026-08-11, 1:04:23 PM | 2026-08-18, 3:49:26 AM | No | ',
    )
    expect(within(list).getByText('135f502b').closest('tr')).toHaveClass('revoked')
    expect(list).toHaveFocus()
    // The keys are asked for again, but not the token, whose key is another.
    await waitFor(() => expect(store.requests).toHaveLength(2))
    expect(rowsOf(list)[2]).toContain('| No |')
    expect(checks).toHaveLength(1)
  })

  it('keeps a key created just before, whose list the revocation interrupts', async () => {
    const { list, store } = await renderKeys()
    mockCreate(store)
    const refetch = gate()
    const refetched = mockKeys({ keys: [CREATED_KEY, ...KEYS], wait: () => refetch.promise })
    createKey('ci-bot')
    await findCreatedKey()
    // The keys are on their way again, with the new one, when the revocation lands.
    await waitFor(() => expect(refetched.requests).toHaveLength(1))
    mockRevoke(refetched)

    fireEvent.click(revokeButton('135f502b'))
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(prompt()).toBeNull())
    await act(async () => refetch.open())

    await waitFor(() => expect(rowsOf(list)[0]).toBe(CREATED_ROW))
  })

  it('sends nothing when cancelled, and gives the focus back to its button', async () => {
    const { list, store } = await renderKeys()
    const prefixes = mockRevoke(store)
    const button = revokeButton('135f502b')
    fireEvent.click(button)

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' }))

    expect(prompt()).not.toBeInTheDocument()
    expect(button).toHaveFocus()
    expect(prefixes).toEqual([])
    expect(within(list).getByText('135f502b').closest('tr')).not.toHaveClass(/confirming/)
  })

  it('shows why a key could not be revoked, in the prompt', async () => {
    const { store } = await renderKeys()
    mockRevoke(store, () =>
      errorResponse(404, 'not_found', "No API key has the prefix '135f502b'."),
    )
    fireEvent.click(revokeButton('135f502b'))

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))

    expect(await within(prompt()).findByRole('alert')).toHaveTextContent(
      'No API key has the prefix',
    )
    expect(rowsOf(await keysTable())[1]).toContain('| Yes |')
  })

  it('keeps the key inactive when a list fetched before arrives after', async () => {
    const { list, queryClient } = await renderKeys()
    const stale = gate()
    const store = mockKeys({ wait: () => stale.promise })
    // The list is fetched again, as when the page is shown again later.
    void queryClient.refetchQueries({ queryKey: queryKeys.apiKeys })
    await waitFor(() => expect(store.requests).toHaveLength(1))
    mockRevoke(store)

    fireEvent.click(revokeButton('135f502b'))
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))
    await waitFor(() => expect(prompt()).toBeNull())
    await act(async () => stale.open())
    await waitFor(() => expect(queryClient.isFetching()).toBe(0))

    expect(rowsOf(list)[2]).toContain('| No |')
  })

  it('checks the token again once its own key is revoked, which denies permission', async () => {
    const { checks, store } = await renderKeys()
    mockRevoke(store)
    fireEvent.click(revokeButton('aaaaaaaa'))
    expect(prompt()).toHaveTextContent(
      'It is the key of the token in Settings: this tab will no longer be available, and a ' +
        'token shown above, not copied yet, will be lost.',
    )
    // The key is revoked now: the API refuses its token.
    const rechecks = mockAuth(unknownToken)

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))

    expect(await main().findByRole('alert')).toHaveTextContent(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings is " +
        'not valid.',
    )
    expect(checks).toHaveLength(1)
    expect(rechecks).toEqual([`Bearer ${TOKEN}`])
    // Nor are the keys asked for again with a token that no longer works.
    expect(store.requests).toHaveLength(1)
  })
})

/**
 * Answer `PATCH /admin/api-keys/{prefix}` by changing the key in `store` as the body says, or with
 * `fail`; returns the prefix and the body of each request.
 */
function mockChange(store: KeyStore, fail?: () => Failure) {
  const sent: { prefix: string; body: Schemas['ApiKeyUpdate'] }[] = []
  server.use(
    mockApi('patch', '/api/admin/api-keys/{prefix}', async ({ params, request }) => {
      const body = (await request.json()) as Schemas['ApiKeyUpdate']
      sent.push({ prefix: params.prefix, body })
      if (fail) return fail()
      const key = store.keys.find((item) => item.prefix === params.prefix)!
      const changed = { ...key, ...body } as ApiKey
      store.keys = store.keys.map((item) => (item.prefix === params.prefix ? changed : item))
      return HttpResponse.json(changed)
    }),
  )
  return sent
}

function editButton(prefix: string) {
  return screen.getByRole('button', { name: `Edit key ${prefix}` })
}

function editForm() {
  return screen.queryByRole('form', { name: /^Edit key / })!
}

function saveButton() {
  return within(editForm()).getByRole('button', { name: /^Sav/ })
}

function cancelButton() {
  return within(editForm()).getByRole('button', { name: 'Cancel' })
}

function editName() {
  return within(editForm()).getByRole('textbox', { name: 'Name' })
}

function rowOf(list: HTMLElement, prefix: string) {
  return within(list).getByText(prefix).closest('tr')!
}

/** Show the keys, as the API lists `keys`, and edit the key `prefix`. */
async function editKey(prefix: string, { keys }: { keys?: ApiKey[] } = {}) {
  const rendered = await renderKeys({ keys })
  const sent = mockChange(rendered.store)
  const button = editButton(prefix)
  fireEvent.click(button)
  await waitFor(() => expect(editForm()).toBeInTheDocument())
  return { ...rendered, sent, button }
}

/** Uncheck and check again `option` of the edit form's tree, which leaves it as it was. */
async function toggleTwice(option: string) {
  await toggleOptions('Projects and suites to restrict to', [option, option], editForm())
}

describe('changing a key', () => {
  it('edits only active keys, in a form saying which, with the focus on its name', async () => {
    const { list, sent, button } = await editKey('135f502b')

    expect(screen.queryByRole('button', { name: 'Edit key 3f0ac112' })).toBeNull()
    expect(editForm()).toHaveAccessibleName('Edit key 135f502b · test-key')
    expect(screen.queryByRole('form', { name: 'Create API Key' })).toBeNull()
    expect(editName()).toHaveFocus()
    expect(editName()).toHaveValue('test-key')
    expect(selectButton('Scope', editForm())).toHaveTextContent('manage')
    expect(within(editForm()).getByRole('radio', { name: 'Only these:' })).toBeChecked()
    expect(selectButton('Projects and suites to restrict to', editForm())).toHaveTextContent(
      'llvm › libcxx, llvm › nts',
    )
    // Marked, but not as a row whose revocation is confirmed.
    expect(rowOf(list, '135f502b')).toHaveClass('editing')
    expect(rowOf(list, '135f502b')).not.toHaveClass(/confirming/)

    fireEvent.click(cancelButton())

    expect(editForm()).toBeNull()
    expect(createForm()).toBeInTheDocument()
    await waitFor(() => expect(button).toHaveFocus())
    expect(rowOf(list, '135f502b')).not.toHaveClass('editing')
    expect(sent).toEqual([])
  })

  it('keeps what the create form holds, and the token shown, while a key is edited', async () => {
    const { store } = await renderKeys()
    mockCreate(store)
    createKey('ci-bot')
    await findCreatedKey()
    fireEvent.change(nameInput(), { target: { value: 'next-bot' } })

    fireEvent.click(editButton('229d78c5'))
    expect(createdKey()).toHaveTextContent('Key ci-bot created.')
    fireEvent.click(cancelButton())

    expect(nameInput()).toHaveValue('next-bot')
    expect(createdKey()).toHaveTextContent(CREATED.token)
  })

  it('leaves the focus in the form when a key created before Edit shows its token', async () => {
    const { store } = await renderKeys()
    const answer = gate()
    mockCreate(store, { wait: () => answer.promise })
    createKey('ci-bot')
    await waitFor(() => expect(createButton()).toHaveTextContent('Creating...'))
    fireEvent.click(editButton('229d78c5'))

    await act(async () => answer.open())

    await findCreatedKey()
    expect(editName()).toHaveFocus()
  })

  it('saves a new name alone without asking, and gives the focus back to Edit', async () => {
    const { list, sent, button, checks } = await editKey('229d78c5')

    fireEvent.change(editName(), { target: { value: ' renamed ' } })
    fireEvent.click(saveButton())

    expect(prompt()).toBeNull()
    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent).toEqual([{ prefix: '229d78c5', body: { name: 'renamed' } }])
    expect(rowsOf(list)[0]).toContain('229d78c5 | renamed | triage | All |')
    await waitFor(() => expect(button).toHaveFocus())
    // Another key than the token's: its check stands.
    expect(checks).toHaveLength(1)
  })

  it('cannot edit another key while a change is saved', async () => {
    const { store } = await renderKeys()
    const answer = gate()
    server.use(
      mockApi('patch', '/api/admin/api-keys/{prefix}', async () => {
        await answer.promise
        return HttpResponse.json(store.keys[0])
      }),
    )
    fireEvent.click(editButton('229d78c5'))
    fireEvent.change(editName(), { target: { value: 'renamed' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(saveButton()).toHaveTextContent('Saving...'))
    expect(editButton('135f502b')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(editButton('135f502b'))
    expect(editForm()).toHaveAccessibleName('Edit key 229d78c5 · test-key2')
    await act(async () => answer.open())
    await waitFor(() => expect(editForm()).toBeNull())
  })

  it('asks before changing the scope and what a key covers, showing what changes', async () => {
    const { list, sent, button } = await editKey('229d78c5')
    await pickOption('Scope', 'manage', editForm())
    fireEvent.click(within(editForm()).getByRole('radio', { name: 'Only these:' }))
    await toggleOptions('Projects and suites to restrict to', ['llvm'], editForm())

    fireEvent.click(saveButton())

    expect(prompt()).toHaveTextContent('Change the key test-key2 (229d78c5)?')
    expect(prompt()).toHaveTextContent('Scope: triage → manage')
    expect(prompt()).toHaveTextContent('Covers: All → llvm (all)')
    expect(prompt()).not.toHaveTextContent('Name:')
    expect(prompt()).toHaveTextContent('Every bot using its token is affected at once.')
    expect(prompt()).not.toHaveTextContent('Settings')
    expect(within(prompt()).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' }))
    expect(prompt()).toBeNull()
    expect(saveButton()).toHaveFocus()
    expect(sent).toEqual([])

    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent).toEqual([
      {
        prefix: '229d78c5',
        body: { scope: 'manage', restricted_to: [{ project: 'llvm', suite: null }] },
      },
    ])
    expect(rowsOf(list)[0]).toContain('229d78c5 | test-key2 | manage | llvm (all) |')
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('names the old and the new name in the prompt when the name changes too', async () => {
    const { sent } = await editKey('229d78c5')
    fireEvent.change(editName(), { target: { value: 'renamed' } })
    await pickOption('Scope', 'manage', editForm())

    fireEvent.click(saveButton())

    expect(prompt()).toHaveTextContent('Name: test-key2 → renamed')
    expect(prompt()).toHaveTextContent('Scope: triage → manage')
    expect(prompt()).not.toHaveTextContent('Covers:')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ name: 'renamed', scope: 'manage' }])
  })

  it('makes a key instance-wide when its scope goes to admin, even if restricted since', async () => {
    const { store, sent } = await editKey('229d78c5')
    // Restricted elsewhere, after the form opened on it as instance-wide.
    store.keys = store.keys.map((key) =>
      key.prefix === '229d78c5' ? { ...key, restricted_to: [entry('nts')] } : key,
    )
    await pickOption('Scope', 'admin', editForm())

    fireEvent.click(saveButton())

    expect(prompt()).toHaveTextContent('Scope: triage → admin')
    // As far as the form knows, it was instance-wide already.
    expect(prompt()).not.toHaveTextContent('Covers:')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ scope: 'admin', restricted_to: null }])
  })

  it('closes without sending anything when nothing changed', async () => {
    const { sent, button } = await editKey('135f502b')
    fireEvent.change(editName(), { target: { value: 'test-key ' } })
    await toggleTwice('llvm › nts')

    fireEvent.click(saveButton())

    expect(prompt()).toBeNull()
    expect(editForm()).toBeNull()
    await waitFor(() => expect(button).toHaveFocus())
    expect(sent).toEqual([])
  })

  it('compares what a key covers whatever the order of its entries', async () => {
    // The API lists entries by name, the tree in the instance's order.
    const key = apiKey('submit', { prefix: '77777777', restricted_to: [entry('nts'), entry('libcxx')] })
    const { sent } = await editKey('77777777', { keys: [key, ...KEYS] })

    await toggleTwice('llvm › libcxx')
    fireEvent.click(saveButton())

    expect(editForm()).toBeNull()
    expect(sent).toEqual([])
  })

  it('keeps what a key covers that the form does not list, until it is changed', async () => {
    // A project created since the projects were listed.
    const key = apiKey('triage', {
      prefix: '77777777',
      name: 'swift-bot',
      restricted_to: [entry('nts'), whole('swift')],
    })
    const { sent } = await editKey('77777777', { keys: [key, ...KEYS] })
    expect(selectButton('Projects and suites to restrict to', editForm())).toHaveTextContent(
      'llvm › nts',
    )

    await pickOption('Scope', 'submit', editForm())
    fireEvent.click(saveButton())
    expect(prompt()).not.toHaveTextContent('Covers:')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' }))
    // Once what it covers is changed, the prompt shows what goes.
    await toggleTwice('llvm › nts')
    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent('Covers: llvm › nts, swift (all) → llvm › nts')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' }))
    await pickOption('Scope', 'triage', editForm())
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ restricted_to: [entry('nts')] }])
  })

  it('shows a suite listed with its whole project as covered by it, keeping both on a rename', async () => {
    const key = apiKey('manage', {
      prefix: '77777777',
      restricted_to: [whole('llvm'), entry('nts')],
    })
    const { sent } = await editKey('77777777', { keys: [key, ...KEYS] })
    const covers = selectButton('Projects and suites to restrict to', editForm())
    expect(covers).toHaveTextContent('llvm (all)')
    expect(covers).not.toHaveTextContent('nts')

    fireEvent.change(editName(), { target: { value: 'renamed' } })
    fireEvent.click(saveButton())

    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ name: 'renamed' }])
  })

  it('shows the suite listed with its whole project going once what the key covers changes', async () => {
    const key = apiKey('manage', {
      prefix: '77777777',
      restricted_to: [whole('llvm'), entry('nts')],
    })
    const { sent } = await editKey('77777777', { keys: [key, ...KEYS] })

    await toggleTwice('llvm')
    fireEvent.click(saveButton())

    expect(prompt()).toHaveTextContent('Covers: llvm (all), llvm › nts → llvm (all)')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ restricted_to: [whole('llvm')] }])
  })

  it('needs something checked once what the key covers is changed, but not before', async () => {
    const nothing = apiKey('submit', { prefix: '77777777', restricted_to: [] })
    const { sent } = await editKey('77777777', { keys: [nothing, ...KEYS] })
    expect(selectButton('Projects and suites to restrict to', editForm())).toHaveTextContent(
      'Select projects or suites',
    )
    // A key covering nothing can still be renamed.
    fireEvent.change(editName(), { target: { value: 'renamed' } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ name: 'renamed' }])

    // Whereas a key covering something cannot be left covering nothing.
    fireEvent.click(editButton('135f502b'))
    await toggleOptions(
      'Projects and suites to restrict to',
      ['llvm › libcxx', 'llvm › nts'],
      editForm(),
    )
    expect(saveButton()).toHaveAccessibleDescription('Pick at least one project or suite.')
  })

  it('makes a restricted key instance-wide through admin, even once back to its scope', async () => {
    const { sent } = await editKey('135f502b')

    await pickOption('Scope', 'admin', editForm())
    expect(within(editForm()).getByRole('radio', { name: /Everything/ })).toBeChecked()
    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent('Scope: manage → admin')
    expect(prompt()).toHaveTextContent('Covers: llvm › libcxx, llvm › nts → All')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' }))
    // "Everything" stays chosen.
    await pickOption('Scope', 'manage', editForm())
    fireEvent.click(saveButton())
    expect(prompt()).not.toHaveTextContent('Scope:')
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ restricted_to: null }])
  })

  it('keeps a restricted key restricted while the projects are not listed', async () => {
    const projects = gate()
    mockSuites(undefined, { wait: () => projects.promise })
    const { sent } = await editKey('135f502b')
    const only = within(editForm()).getByRole('radio', { name: 'Only these:' })
    expect(only).toBeChecked()
    expect(only).toBeDisabled()

    await pickOption('Scope', 'triage', editForm())
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(editForm()).toBeNull())
    expect(sent.map(({ body }) => body)).toEqual([{ scope: 'triage' }])
    projects.open()
  })

  it("keeps the form as it was, with the API's message, when the change fails", async () => {
    const { store } = await renderKeys()
    mockChange(store, () => errorResponse(400, 'validation_error', 'The name is too long.'))
    fireEvent.click(editButton('229d78c5'))
    fireEvent.change(editName(), { target: { value: 'renamed' } })

    fireEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('The name is too long.')
    expect(editName()).toHaveValue('renamed')
    expect(saveButton()).toBeEnabled()
    // Nothing changed elsewhere: the keys are not asked for again.
    expect(store.requests).toHaveLength(1)
  })

  it('cannot save a key revoked elsewhere, and gives the focus to the table on Cancel', async () => {
    const { list, store } = await renderKeys()
    mockChange(store, () => {
      store.keys = store.keys.map((key) =>
        key.prefix === '229d78c5' ? { ...key, is_active: false } : key,
      )
      return errorResponse(409, 'conflict', "API key '229d78c5' is revoked.")
    })
    fireEvent.click(editButton('229d78c5'))
    fireEvent.change(editName(), { target: { value: 'renamed' } })
    saveButton().focus()

    fireEvent.click(saveButton())

    expect(await screen.findByRole('alert')).toHaveTextContent("API key '229d78c5' is revoked.")
    // The keys are asked for again, which shows it revoked.
    await waitFor(() => expect(rowOf(list, '229d78c5')).toHaveClass('revoked'))
    expect(store.requests).toHaveLength(2)
    expect(saveButton()).toBeDisabled()
    expect(saveButton()).toHaveAccessibleDescription(
      'This key has been revoked: it can no longer be changed.',
    )
    expect(cancelButton()).toHaveFocus()
    expect(editName()).toHaveValue('renamed')

    fireEvent.click(cancelButton())

    await waitFor(() => expect(list).toHaveFocus())
  })

  it('cannot save a key revoked here meanwhile', async () => {
    const { list, store } = await editKey('229d78c5')
    mockRevoke(store)

    fireEvent.click(revokeButton('229d78c5'))
    // Marked as both, its revocation's mark showing over the edit's (see admin.module.css).
    expect(rowOf(list, '229d78c5')).toHaveClass('editing')
    expect(rowOf(list, '229d78c5')).toHaveClass(/confirming/)
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(saveButton()).toBeDisabled())
    expect(editForm()).toBeInTheDocument()
  })

  it('asks for the projects again when one the key would cover is gone', async () => {
    const suites = mockSuites()
    const { store } = await renderKeys()
    await waitFor(() => expect(suites.requests).toBe(1))
    mockChange(store, () => errorResponse(404, 'not_found', "Project 'llvm' does not exist."))
    fireEvent.click(editButton('229d78c5'))
    fireEvent.click(within(editForm()).getByRole('radio', { name: 'Only these:' }))
    await toggleOptions('Projects and suites to restrict to', ['llvm'], editForm())
    fireEvent.click(saveButton())
    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Project 'llvm' does not exist.")
    await waitFor(() => expect(suites.requests).toBe(2))
    expect(store.requests).toHaveLength(2)
  })

  it('edits another key on its Edit, keeping the form on the same Edit', async () => {
    const { list } = await editKey('229d78c5')
    fireEvent.change(editName(), { target: { value: 'half-typed' } })
    cancelButton().focus()

    fireEvent.click(editButton('229d78c5'))
    expect(editName()).toHaveValue('half-typed')
    expect(editName()).toHaveFocus()

    fireEvent.click(editButton('135f502b'))
    expect(editForm()).toHaveAccessibleName('Edit key 135f502b · test-key')
    expect(editName()).toHaveValue('test-key')
    expect(editName()).toHaveFocus()
    expect(rowOf(list, '229d78c5')).not.toHaveClass('editing')
    expect(rowOf(list, '135f502b')).toHaveClass('editing')
  })

  it('keeps the form open, and out of the URL, while the keys are sorted', async () => {
    const { list } = await editKey('229d78c5')
    fireEvent.change(editName(), { target: { value: 'half-typed' } })

    fireEvent.click(within(list).getByRole('button', { name: 'Name' }))

    await waitFor(() => expect(currentUrl()).toBe('/admin?sort=name'))
    expect(editName()).toHaveValue('half-typed')
  })

  it('checks the token again once its own key is changed, then gives the focus back to Edit', async () => {
    const { button } = await editKey('aaaaaaaa')
    const check = gate()
    const rechecks = mockAuth(async () => {
      await check.promise
      return HttpResponse.json({ key: { ...OWN, name: 'renamed' } })
    })
    fireEvent.change(editName(), { target: { value: 'renamed' } })

    fireEvent.click(saveButton())

    await waitFor(() => expect(rechecks).toEqual([`Bearer ${TOKEN}`]))
    // Edit is disabled while the token is checked.
    expect(button).toBeDisabled()
    expect(button).not.toHaveFocus()
    await act(async () => check.open())
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('warns before taking admin away from its own token, which then denies permission', async () => {
    const { store } = await editKey('aaaaaaaa')
    await pickOption('Scope', 'manage', editForm())
    fireEvent.click(saveButton())
    expect(prompt()).toHaveTextContent(
      'It is the key of the token in Settings: this tab will no longer be available, and a ' +
        'token shown below, not copied yet, will be lost.',
    )
    mockAuth(() => HttpResponse.json({ key: { ...OWN, scope: 'manage' } }))

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Save' }))

    expect(await main().findByRole('alert')).toHaveTextContent(
      "Permission denied. Needs an API token with the 'admin' scope. The token in Settings has " +
        "the 'manage' scope.",
    )
    // Nor are the keys asked for again with a token that can no longer list them.
    expect(store.requests).toHaveLength(1)
  })
})
