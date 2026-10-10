import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { ApiKey } from '../../api/api-keys'
import { PERMISSION_DENIED, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { TOKEN_STORAGE_KEY } from '../../auth/storage-key'
import { apiKey, changeInAnotherTab, mockAuth, signIn, TOKEN, unknownToken } from '../../test/auth'
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
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

/** The key of the token `signIn` stores, among the others. */
const OWN = apiKey('admin', {
  name: 'my-admin',
  created_at: '2026-08-05T10:00:00Z',
  last_used_at: '2026-08-20T08:00:00Z',
})

/** As the API lists them: newest first. */
const KEYS: ApiKey[] = [
  apiKey('read', {
    prefix: '229d78c5',
    name: 'test-key2',
    created_at: '2026-08-13T03:01:04Z',
    last_used_at: null,
  }),
  apiKey('manage', {
    prefix: '135f502b',
    name: 'test-key',
    created_at: '2026-08-11T13:04:23Z',
    last_used_at: '2026-08-18T03:49:26Z',
  }),
  OWN,
  apiKey('submit', {
    prefix: '3f0ac112',
    name: 'old-bot',
    created_at: '2026-07-02T09:12:44Z',
    last_used_at: '2026-08-01T18:20:11Z',
    is_active: false,
  }),
]

const ROWS = [
  '229d78c5 | test-key2 | read | 2026-08-13, 3:01:04 AM | Never | Yes | Revoke',
  '135f502b | test-key | manage | 2026-08-11, 1:04:23 PM | 2026-08-18, 3:49:26 AM | Yes | Revoke',
  'aaaaaaaa | my-admin | admin | 2026-08-05, 10:00:00 AM | 2026-08-20, 8:00:00 AM | Yes | Revoke',
  '3f0ac112 | old-bot | submit | 2026-07-02, 9:12:44 AM | 2026-08-01, 6:20:11 PM | No | ',
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

const CREATED_ROW = '5e5e5e5e | ci-bot | submit | 2026-08-21, 12:00:00 PM | Never | Yes | Revoke'

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

describe('the Admin page', () => {
  it('opens on its API Keys tab, and keeps the other in the URL', async () => {
    mockSuites()
    renderPage('/admin')

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Admin')
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'API Keys',
      'Test Suites',
    ])
    expect(screen.getByRole('tab', { name: 'API Keys' })).toHaveAttribute('aria-selected', 'true')

    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
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
  it('says that permission is denied without a token, and asks for no keys', async () => {
    const { requests } = mockKeys()
    renderPage('/admin')

    expect((await main().findByRole('alert')).textContent).toBe(PERMISSION_DENIED)
    expect(screen.queryByRole('form', { name: 'Create API Key' })).not.toBeInTheDocument()
    expect(requests).toEqual([])
  })

  it.each(['read', 'manage'] as const)(
    'says that permission is denied with a %s token',
    async (scope) => {
      signIn(scope)
      const { requests } = mockKeys()
      renderPage('/admin')

      expect(await main().findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
      expect(requests).toEqual([])
    },
  )

  it('says that permission is denied when the token is not valid', async () => {
    localStorage.setItem(TOKEN_STORAGE_KEY, TOKEN)
    mockAuth(unknownToken)
    renderPage('/admin')

    expect(await main().findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
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

  it('lists every key with the token, newest first, revoked ones without Revoke', async () => {
    const { list, store } = await renderKeys()

    expect(rowsOf(list)).toEqual(ROWS)
    expect(headersOf(list)).toEqual([
      'Prefix',
      'Name',
      'Scope',
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

  it('sorts by Last Used, with the keys never used last in both directions', async () => {
    const { list } = await renderKeys()

    fireEvent.click(within(list).getByRole('button', { name: 'Last Used' }))
    expect(prefixes(list)).toEqual(['3f0ac112', '135f502b', 'aaaaaaaa', '229d78c5'])
    expect(screen.getByRole('columnheader', { name: /Last Used/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    )
    expect(screen.getByRole('columnheader', { name: 'Created' })).not.toHaveAttribute('aria-sort')

    fireEvent.click(within(list).getByRole('button', { name: /Last Used/ }))
    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '3f0ac112', '229d78c5'])
  })

  it('sorts scopes from the lowest to the highest, and the other columns by value', async () => {
    const { list, store } = await renderKeys()

    fireEvent.click(within(list).getByRole('button', { name: 'Scope' }))
    expect(prefixes(list)).toEqual(['229d78c5', '3f0ac112', '135f502b', 'aaaaaaaa'])

    // my-admin, old-bot, test-key, test-key2.
    fireEvent.click(within(list).getByRole('button', { name: 'Name' }))
    expect(prefixes(list)).toEqual(['aaaaaaaa', '3f0ac112', '135f502b', '229d78c5'])

    fireEvent.click(within(list).getByRole('button', { name: 'Prefix' }))
    expect(prefixes(list)).toEqual(['135f502b', '229d78c5', '3f0ac112', 'aaaaaaaa'])

    // The inactive key first, then the others in the order the API gave them.
    fireEvent.click(within(list).getByRole('button', { name: 'Active' }))
    expect(prefixes(list)).toEqual(['3f0ac112', '229d78c5', '135f502b', 'aaaaaaaa'])

    fireEvent.click(within(list).getByRole('button', { name: 'Created' }))
    expect(prefixes(list)).toEqual(['3f0ac112', 'aaaaaaaa', '135f502b', '229d78c5'])

    // Sorting asks the API for nothing.
    expect(store.requests).toHaveLength(1)
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

    expect(prefixes(list)).toEqual(['aaaaaaaa', '135f502b', '3f0ac112', '229d78c5'])
  })

  it.each(['created', '-nope', 'revoke'])('drops the sort %s, which it cannot use', async (sort) => {
    const { list } = await renderKeys({ url: `/admin?sort=${sort}` })

    expect(rowsOf(list)).toEqual(ROWS)
    await waitFor(() => expect(currentUrl()).toBe('/admin'))
  })

  it('drops the sort on leaving the tab', async () => {
    mockSuites()
    renderPage('/admin?sort=name')

    fireEvent.click(await screen.findByRole('tab', { name: 'Test Suites' }))
    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
  })

  it('drops the sort from the URL of the Test Suites tab', async () => {
    mockSuites()
    renderPage('/admin?tab=suites&sort=name')

    await waitFor(() => expect(currentUrl()).toBe('/admin?tab=suites'))
  })
})

describe('creating a key', () => {
  it('creates a key of the name and scope given, and shows its token once', async () => {
    const { store } = await renderKeys()
    const sent = mockCreate(store)
    expect(createButton()).toBeDisabled()
    expect(createButton()).toHaveAccessibleDescription('Give the key a name first.')
    expect(selectButton('Scope', createForm())).toHaveTextContent('read')

    fireEvent.change(nameInput(), { target: { value: ' ci-bot ' } })
    await pickOption('Scope', 'submit', createForm())
    fireEvent.click(createButton())

    const created = await findCreatedKey()
    expect(sent.map(({ body }) => body)).toEqual([{ name: 'ci-bot', scope: 'submit' }])
    expect(created).toHaveTextContent(
      'Key created. Copy the token now — it will not be shown again:',
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

    fireEvent.click(screen.getByRole('tab', { name: 'Test Suites' }))
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
  it('asks first, then flips the row to inactive in place, without its Revoke button', async () => {
    const { list, store, checks } = await renderKeys()
    const prefixes = mockRevoke(store)

    fireEvent.click(revokeButton('135f502b'))
    expect(prompt()).toHaveTextContent('Revoke the key test-key (135f502b)?')
    expect(prompt()).not.toHaveTextContent('Settings')
    // Nothing to type: revoking a key destroys no data (AR2 "Deletions").
    expect(within(prompt()).queryByRole('textbox')).not.toBeInTheDocument()
    expect(within(prompt()).getByRole('button', { name: 'Cancel' })).toHaveFocus()
    expect(within(list).getByText('135f502b').closest('tr')).toHaveClass(/confirming/)
    expect(prefixes).toEqual([])

    fireEvent.click(within(prompt()).getByRole('button', { name: 'Revoke' }))

    await waitFor(() => expect(prompt()).toBeNull())
    expect(prefixes).toEqual(['135f502b'])
    expect(rowsOf(list)[1]).toBe(
      '135f502b | test-key | manage | 2026-08-11, 1:04:23 PM | 2026-08-18, 3:49:26 AM | No | ',
    )
    expect(list).toHaveFocus()
    // The keys are asked for again, but not the token, whose key is another.
    await waitFor(() => expect(store.requests).toHaveLength(2))
    expect(rowsOf(list)[1]).toContain('| No |')
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

    expect(rowsOf(list)[1]).toContain('| No |')
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

    expect(await main().findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
    expect(checks).toHaveLength(1)
    expect(rechecks).toEqual([`Bearer ${TOKEN}`])
    // Nor are the keys asked for again with a token that no longer works.
    expect(store.requests).toHaveLength(1)
  })
})
