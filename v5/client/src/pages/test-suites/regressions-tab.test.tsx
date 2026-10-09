import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import { PERMISSION_DENIED } from '../../api/client'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { signIn, TOKEN } from '../../test/auth'
import { commit, cursorPage, machine, regression, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  mockCommits,
  mockMachines,
  mockRegressions,
  mockResolve,
  mockRuns,
  mockSuites,
  renderPage,
  rowsOf,
  search,
  table,
  type Page,
  type Respond,
} from '../../test/page'
import { server } from '../../test/server'

type Regression = Schemas['Regression']

const MACHINES = ['linux-x86_64', 'macos-arm64']
/** The accessible name of the tab's search, which matches titles and UUID prefixes (TS5). */
const SEARCH = 'Search regressions by title or UUID prefix'
const TAGGED = commit('abc123', { tag: 'v1', fields: { svn_revision: 'r100', commit_info: null } })

/** The suite's machines, for the machine combobox; returns the queries it was listed with. */
function mockMachineNames(names = MACHINES) {
  return mockMachines(() => ({ items: names.map((name) => machine(name)), total: names.length }))
}

/** The page on the Regressions tab at `query`, with the suites, machines and commits it reads. */
function renderTab(query = '', respond?: Respond<Page<Regression>>) {
  mockSuites()
  const machines = mockMachineNames()
  const regressions = mockRegressions(respond)
  const resolved = mockResolve([TAGGED])
  renderPage(`/suites/libcxx?tab=regressions${query}`)
  return { machines, regressions, resolved }
}

/** The body row of the regression titled `title`. */
function rowOf(title: string) {
  return screen.getByRole('link', { name: title }).closest('tr')!
}

function machineInput() {
  return screen.getByRole('combobox', { name: 'Machine' })
}

describe('the Regressions tab', () => {
  it('lists the regressions newest first, with their commit by display value', async () => {
    const { regressions, resolved } = renderTab('', () =>
      cursorPage([
        regression('a', {
          title: 'find_if slowdown',
          state: 'active',
          commit: 'abc123',
          machine_count: 2,
          test_count: 12,
          bug: 'https://github.com/llvm/llvm-project/issues/1234',
        }),
        regression('b', { title: null, state: 'not_to_be_fixed', bug: 'PR1234' }),
      ]),
    )

    const list = await table('Regressions')
    await waitFor(() =>
      expect(rowsOf(list)).toEqual([
        'aaaaaaaa… | find_if slowdown | active | r100 (v1) | 2 | 12 | 2026-08-31, 3:03:36 PM | ' +
          'https://github.com/llvm/llvm-project/issues/1234 | Delete',
        'bbbbbbbb… | (untitled) | not to be fixed | -- | 0 | 0 | 2026-08-31, 3:03:36 PM | ' +
          'PR1234 | Delete',
      ]),
    )
    expect(Object.fromEntries(regressions[0])).toEqual({ sort: '-created_at', limit: '25' })
    expect(resolved).toEqual([['abc123']])

    expect(within(list).getByRole('link', { name: '(untitled)' })).toHaveAttribute(
      'href',
      `/suites/libcxx/regressions/${uuidOf('b')}`,
    )
    expect(within(list).getByRole('link', { name: 'r100 (v1)' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/abc123',
    )
    const bug = within(list).getByRole('link', { name: /issues\/1234/ })
    expect(bug).toHaveAttribute('target', '_blank')
    // A bug that is not a web URL is shown, not linked.
    expect(within(list).queryByRole('link', { name: 'PR1234' })).toBeNull()
  })

  it('leads with the shortened UUID, which tells untitled regressions apart', async () => {
    renderTab('', () =>
      cursorPage([regression('a', { title: null }), regression('b', { title: null })]),
    )

    const list = await table('Regressions')
    const header = within(list).getAllByRole('columnheader')[0]
    expect(header).toHaveTextContent('UUID')
    // An identifier is set in a fixed-width font, but the header that names it is not.
    expect(header).not.toHaveClass('mono')
    for (const hex of ['a', 'b']) {
      const link = within(list).getByRole('link', { name: `${hex.repeat(8)}…` })
      expect(link).toHaveAttribute('href', `/suites/libcxx/regressions/${uuidOf(hex)}`)
      expect(link).toHaveAttribute('title', uuidOf(hex))
      expect(link.closest('td')).toHaveClass('mono')
    }
  })

  it('never links a bug that is not a web URL', async () => {
    renderTab('', () => cursorPage([regression('a', { bug: 'javascript:alert(1)' })]))

    const list = await table('Regressions')
    expect(within(list).getByText('javascript:alert(1)').closest('a')).toBeNull()
  })

  it('says when there are no regressions, and when none match the filters', async () => {
    renderTab()
    expect(await screen.findByText('No regressions yet.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'fixed' }))
    expect(await screen.findByText('No regressions match these filters.')).toBeInTheDocument()
  })

  it('filters by state, machine, metric, commit and title, each from the first page', async () => {
    const { regressions } = renderTab('', (query) =>
      cursorPage([regression('a')], query.has('cursor') ? null : 'p2'),
    )
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    await waitFor(() => expect(regressions).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'fixed' }))
    fireEvent.click(screen.getByRole('button', { name: 'active' }))
    const user = userEvent.setup()
    await user.type(machineInput(), 'macos')
    await user.click(await screen.findByRole('option', { name: 'macos-arm64' }))
    fireEvent.change(screen.getByLabelText('Metric'), { target: { value: 'execution_time' } })
    fireEvent.click(screen.getByLabelText('No commit set'))
    search(SEARCH, 'slow')

    await waitFor(() =>
      expect(currentUrl()).toBe(
        '/suites/libcxx?tab=regressions&state=active&state=fixed&machine=macos-arm64' +
          '&metric=execution_time&has_commit=false&search=slow',
      ),
    )
    const last = regressions.at(-1)!
    expect(last.getAll('state')).toEqual(['active', 'fixed'])
    expect(last.get('machine')).toBe('macos-arm64')
    expect(last.get('metric')).toBe('execution_time')
    expect(last.get('has_commit')).toBe('false')
    expect(last.get('search')).toBe('slow')
    expect(last.has('cursor')).toBe(false)
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  it('restores every filter from the URL', async () => {
    const { regressions } = renderTab(
      '&search=slow&state=detected&machine=linux-x86_64&metric=execution_time&has_commit=false',
    )

    await table('Regressions')
    expect(screen.getByRole('button', { name: 'detected' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: 'active' })).toHaveAttribute('aria-pressed', 'false')
    expect(machineInput()).toHaveValue('linux-x86_64')
    expect(screen.getByLabelText('Metric')).toHaveValue('execution_time')
    expect(screen.getByLabelText('No commit set')).toBeChecked()
    expect(screen.getByRole('searchbox', { name: SEARCH })).toHaveValue('slow')
    expect(Object.fromEntries(regressions[0])).toMatchObject({
      state: 'detected',
      machine: 'linux-x86_64',
      metric: 'execution_time',
      has_commit: 'false',
      search: 'slow',
    })
  })

  it('clears the machine filter when its input is emptied', async () => {
    const { regressions } = renderTab('&machine=linux-x86_64')
    await table('Regressions')

    await userEvent.setup().clear(machineInput())

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=regressions'))
    await waitFor(() => expect(regressions.at(-1)?.has('machine')).toBe(false))
  })

  it('drops a metric the suite does not have, without asking for it', async () => {
    const { regressions } = renderTab('&metric=nope')

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=regressions'))
    await table('Regressions')
    expect(regressions.every((query) => !query.has('metric'))).toBe(true)
    expect(screen.getByLabelText('Metric')).toHaveValue('')
  })

  it('drops a machine once the machine list shows it does not exist', async () => {
    mockSuites()
    const list = gate()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/machines', async () => {
        await list.promise
        return HttpResponse.json({ items: [machine('linux-x86_64')], total: 1 })
      }),
    )
    mockRegressions()
    renderPage('/suites/libcxx?tab=regressions&machine=gone')
    await table('Regressions')
    expect(currentUrl()).toBe('/suites/libcxx?tab=regressions&machine=gone')

    act(() => list.open())

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=regressions'))
  })

  it('keeps the machine when the machine list fails, and says so', async () => {
    mockSuites()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/machines', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    mockRegressions()
    renderPage('/suites/libcxx?tab=regressions&machine=linux-x86_64')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(currentUrl()).toBe('/suites/libcxx?tab=regressions&machine=linux-x86_64')
  })

  it('drops its filters on another tab, and clears them when switching tabs', async () => {
    mockSuites()
    mockRegressions()
    mockMachineNames()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?state=fixed&has_commit=false')
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))

    fireEvent.click(screen.getByRole('tab', { name: 'Regressions' }))
    fireEvent.click(await screen.findByRole('button', { name: 'fixed' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=regressions&state=fixed'))

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
  })

  it('opens a regression by a click on its row, but not on the links it holds', async () => {
    renderTab('', () =>
      cursorPage([regression('a', { title: 'slow', commit: 'abc123', bug: 'https://bugs/1' })]),
    )
    await table('Regressions')

    fireEvent.click(within(rowOf('slow')).getByRole('link', { name: 'https://bugs/1' }))
    expect(currentUrl()).toBe('/suites/libcxx?tab=regressions')

    fireEvent.click(within(rowOf('slow')).getAllByRole('cell')[3])
    await waitFor(() => expect(currentUrl()).toBe(`/suites/libcxx/regressions/${uuidOf('a')}`))
    expect(await screen.findByRole('heading', { name: 'Regression Detail' })).toBeInTheDocument()
  })

  it('leaves a modified click on a row, or one ending a text selection, to the browser', async () => {
    renderTab('', () => cursorPage([regression('a', { title: 'slow' })]))
    await table('Regressions')
    const cell = within(rowOf('slow')).getAllByRole('cell')[3]

    fireEvent.click(cell, { metaKey: true })
    fireEvent.click(cell, { ctrlKey: true })
    fireEvent.click(cell, { shiftKey: true })
    fireEvent.click(cell, { button: 1 })
    const selection = vi.spyOn(window, 'getSelection').mockReturnValue({
      toString: () => 'slo',
    } as Selection)
    fireEvent.click(cell)
    selection.mockRestore()

    expect(currentUrl()).toBe('/suites/libcxx?tab=regressions')
  })

  it('pages with Previous and Next', async () => {
    renderTab('', (query) =>
      query.get('cursor') === 'p2'
        ? cursorPage([regression('b', { title: 'older' })])
        : cursorPage([regression('a', { title: 'newer' })], 'p2'),
    )
    await screen.findByRole('link', { name: 'newer' })

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByRole('link', { name: 'older' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Previous/ }))
    expect(await screen.findByRole('link', { name: 'newer' })).toBeInTheDocument()
  })
})

describe('the Regressions tab without triage scope', () => {
  it('disables creating and deleting, saying which scope they need', async () => {
    renderTab('', () => cursorPage([regression('a', { title: 'slow' })]))
    await table('Regressions')

    const create = screen.getByRole('button', { name: 'New Regression' })
    expect(create).toBeDisabled()
    expect(create).toHaveAttribute('title', expect.stringContaining("'triage' scope"))
    const remove = within(rowOf('slow')).getByRole('button', { name: /Delete/ })
    expect(remove).toBeDisabled()
    expect(remove).toHaveAttribute('title', expect.stringContaining("'triage' scope"))
  })

  it('keeps them disabled with a token of a lower scope', async () => {
    signIn('submit')
    renderTab('', () => cursorPage([regression('a', { title: 'slow' })]))
    await table('Regressions')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'New Regression' })).toHaveAttribute(
        'title',
        expect.stringContaining("has the 'submit' scope"),
      ),
    )
    expect(screen.getByRole('button', { name: 'New Regression' })).toBeDisabled()
  })
})

describe('creating a regression', () => {
  /** Open the form, as a holder of a triage key. */
  async function openForm() {
    signIn('triage')
    const view = renderTab()
    const commits = mockCommits((query) => {
      const text = query.get('search') ?? ''
      return cursorPage([TAGGED, commit('def456')].filter((c) => c.value.includes(text)))
    })
    const button = await screen.findByRole('button', { name: 'New Regression' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    return { ...view, commits, form: screen.getByRole('form', { name: 'New regression' }) }
  }

  /** Answer the creation with a regression of UUID `uuidOf('c')`; returns the bodies received. */
  function mockCreate() {
    const bodies: Schemas['RegressionCreate'][] = []
    const headers: (string | null)[] = []
    server.use(
      mockApi('post', '/api/suites/{testsuite}/regressions', async ({ request }) => {
        bodies.push(await request.json())
        headers.push(request.headers.get('Authorization'))
        return HttpResponse.json(
          { ...regression('c'), notes: null, indicators: [] },
          { status: 201 },
        )
      }),
    )
    return { bodies, headers }
  }

  it('creates one with a commit picked among the suggestions, then shows it', async () => {
    const { form, commits } = await openForm()
    const { bodies, headers } = mockCreate()

    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: ' find_if slow ' } })
    fireEvent.change(within(form).getByLabelText('Bug'), { target: { value: 'https://bugs/1' } })
    fireEvent.change(within(form).getByLabelText('State'), { target: { value: 'active' } })
    const picker = within(form).getByRole('combobox', { name: 'Commit' })
    const user = userEvent.setup()
    await user.type(picker, 'abc')
    await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))
    expect(picker).toHaveValue('r100 (v1)')
    await user.click(within(form).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(currentUrl()).toBe(`/suites/libcxx/regressions/${uuidOf('c')}`))
    expect(bodies).toEqual([
      { title: 'find_if slow', bug: 'https://bugs/1', state: 'active', commit: 'abc123' },
    ])
    expect(headers).toEqual([`Bearer ${TOKEN}`])
    // The picker offers every commit of the suite.
    expect(commits.every((query) => !query.has('machine'))).toBe(true)
  })

  it('sends no title, bug or commit when they are left empty', async () => {
    const { form } = await openForm()
    const { bodies } = mockCreate()

    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: '   ' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(bodies[0]).toEqual({ title: null, bug: null, state: 'detected', commit: null })
  })

  describe('while the commit picker holds text that was not picked', () => {
    const REASON = 'Pick a commit from the list, or clear the field.'

    /** Open the form, and type `text` into its commit picker without picking anything. */
    async function typeCommit(text: string) {
      const { form } = await openForm()
      const user = userEvent.setup()
      const picker = within(form).getByRole('combobox', { name: 'Commit' })
      await user.type(picker, text)
      // Hidden from the accessibility tree while the list is open, but there to be clicked.
      const create = within(form).getByRole('button', { name: 'Create', hidden: true })
      return { form, user, picker, create }
    }

    it('cannot create, and says why', async () => {
      const { form, create } = await typeCommit('abc')

      expect(create).toHaveAttribute('aria-disabled', 'true')
      const reason = within(form).getByText(REASON)
      expect(create).toHaveAttribute('aria-describedby', reason.id)
    })

    it('creates nothing on a click on Create, which keeps the text in the picker', async () => {
      const { user, picker, create } = await typeCommit('abc')
      const { bodies } = mockCreate()

      await user.click(create)

      expect(picker).toHaveFocus()
      expect(picker).toHaveValue('abc')
      expect(create).toHaveAttribute('aria-disabled', 'true')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(bodies).toEqual([])
    })

    it('can create once a commit is picked', async () => {
      const { form, user, create } = await typeCommit('abc')

      await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))

      expect(create).not.toHaveAttribute('aria-disabled')
      expect(create).not.toHaveAttribute('aria-describedby')
      expect(within(form).queryByText(REASON)).toBeNull()
    })

    it('can create once the picker is cleared, for no commit', async () => {
      const { form, user, picker, create } = await typeCommit('abc')

      await user.clear(picker)

      expect(create).not.toHaveAttribute('aria-disabled')
      expect(within(form).queryByText(REASON)).toBeNull()
    })

    it('can create once it is left, which puts back the text of its value', async () => {
      const { form, user, picker, create } = await typeCommit('abc')

      await user.click(within(form).getByLabelText('Title'))

      expect(picker).toHaveValue('')
      expect(create).not.toHaveAttribute('aria-disabled')
    })

    it('takes the text of the commit picked, typed back, as nothing pending', async () => {
      const { user, picker, create } = await typeCommit('abc')
      await user.click(await screen.findByRole('option', { name: 'r100 (v1)' }))

      await user.tripleClick(picker)
      await user.keyboard('r100')
      expect(create).toHaveAttribute('aria-disabled', 'true')
      await user.keyboard(' (v1)')

      expect(picker).toHaveValue('r100 (v1)')
      expect(create).not.toHaveAttribute('aria-disabled')
    })
  })

  it('stays open with what was entered when the creation fails', async () => {
    const { form } = await openForm()
    server.use(
      mockApi('post', '/api/suites/{testsuite}/regressions', () =>
        errorResponse(400, 'invalid_request', 'The bug is too long'),
      ),
    )

    fireEvent.change(within(form).getByLabelText('Title'), { target: { value: 'slow' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Create' }))

    expect(await within(form).findByRole('alert')).toHaveTextContent('The bug is too long')
    expect(within(form).getByLabelText('Title')).toHaveValue('slow')
    expect(currentUrl()).toBe('/suites/libcxx?tab=regressions')
  })

  it('closes with Cancel, or the button that opened it', async () => {
    await openForm()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('form', { name: 'New regression' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'New Regression' }))
    expect(screen.getByRole('form', { name: 'New regression' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New Regression' }))
    expect(screen.queryByRole('form', { name: 'New regression' })).toBeNull()
  })
})

describe('deleting a regression', () => {
  const SLOW = regression('5', { title: 'slow' })

  async function openPrompt() {
    const checks = signIn('triage')
    let deleted = false
    const view = renderTab('', () => cursorPage(deleted ? [] : [SLOW]))
    await table('Regressions')
    const button = within(rowOf('slow')).getByRole('button', { name: /Delete/ })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    return { ...view, checks, markDeleted: () => (deleted = true) }
  }

  it('asks for the first 8 characters of the UUID, then deletes it and lists the rest', async () => {
    const { regressions, machines, checks, markDeleted } = await openPrompt()
    const requests: string[] = []
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/regressions/{uuid}', ({ params, request }) => {
        requests.push(`${params.uuid} ${request.headers.get('Authorization')}`)
        markDeleted()
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    expect(prompt).toHaveTextContent('Delete the regression slow')
    expect(prompt).toHaveTextContent('Type 55555555 to confirm')
    const before = regressions.length
    fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: '55555555' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

    expect(await screen.findByText('No regressions yet.')).toBeInTheDocument()
    expect(requests).toEqual([`${SLOW.uuid} Bearer ${TOKEN}`])
    expect(screen.queryByRole('form', { name: 'Confirmation' })).toBeNull()
    // Only the regressions are asked for again: neither the machines nor the token's check are.
    expect(regressions.length).toBe(before + 1)
    expect(machines).toHaveLength(1)
    expect(checks).toHaveLength(1)
  })

  it('reports a refusal in the prompt, which stays open', async () => {
    await openPrompt()
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/regressions/{uuid}', () =>
        errorResponse(403, 'forbidden', 'Insufficient scope'),
      ),
    )

    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: '55555555' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

    expect(await within(prompt).findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
    expect(rowOf('slow')).toBeInTheDocument()
  })

  it('leaves everything as it was on Cancel or Escape, back on the Delete button', async () => {
    await openPrompt()
    const button = within(rowOf('slow')).getByRole('button', { name: /Delete/ })

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form', { name: 'Confirmation' })).toBeNull()
    expect(rowOf('slow')).toBeInTheDocument()
    expect(button).toHaveFocus()

    fireEvent.click(button)
    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    fireEvent.keyDown(within(prompt).getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('form', { name: 'Confirmation' })).toBeNull()
    expect(button).toHaveFocus()
  })

  it('allows one deletion at a time, and leaves the focus on the table after it', async () => {
    await openPrompt()
    const done = gate()
    server.use(
      mockApi('delete', '/api/suites/{testsuite}/regressions/{uuid}', async () => {
        await done.promise
        return new HttpResponse(null, { status: 204 })
      }),
    )

    const prompt = screen.getByRole('form', { name: 'Confirmation' })
    fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: '55555555' } })
    fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(within(rowOf('slow')).getByRole('button', { name: /Delete/ })).toBeDisabled(),
    )
    act(() => done.open())
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Confirmation' })).toBeNull())
    expect(screen.getByRole('table', { name: 'Regressions' })).toHaveFocus()
  })
})

describe('the title search', () => {
  it('searches the server once typing pauses', async () => {
    const { regressions } = renderTab()
    await table('Regressions')

    search(SEARCH, 's')
    search(SEARCH, 'slow')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))

    expect(regressions.slice(1).map((query) => query.get('search'))).toEqual(['slow'])
  })
})
