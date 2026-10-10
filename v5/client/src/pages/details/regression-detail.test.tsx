import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { formatTimestamp } from '../../format'
import { signIn, TOKEN } from '../../test/auth'
import {
  commit,
  cursorPage,
  machine,
  SUITE,
  regression,
  regressionDetail,
  uuidOf,
} from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  editButton,
  gate,
  infoRows,
  main,
  mockCommits,
  mockMachines,
  mockRegressions,
  mockResolve,
  mockSent,
  mockSuites,
  mockTests,
  ready,
  renderPage,
  rowsOf,
  save,
  search,
  table,
} from '../../test/page'
import { selectButton } from '../../test/select'
import { server } from '../../test/server'

const UUID = uuidOf('a')
const PAGE = `/suites/libcxx/regressions/${UUID}`
const ROUTE = '/api/suites/{testsuite}/regressions/{uuid}'

type Regression = Schemas['RegressionDetail']

/** A commit with a display value, and one without. */
const TAGGED = commit('abc123', { tag: 'v1', fields: { svn_revision: 'r100', commit_info: null } })
const PLAIN = commit('def456')

const DETAIL = regressionDetail('a', {
  title: 'find_if slowdown',
  bug: 'https://bugs.example/1',
  state: 'active',
  commit: TAGGED.value,
  notes: 'Bisected.\nOnly x86.',
  indicators: [
    { uuid: uuidOf('1'), machine: 'linux', test: 'BM_find_if', metric: 'execution_time' },
    { uuid: uuidOf('2'), machine: 'macos', test: 'BM_find_if', metric: 'execution_time' },
  ],
})

interface Options {
  url?: string
  suites?: SuiteSchema[]
  /** The suite's machines, `linux` and `macos` by default. */
  machines?: string[]
  /** The answer to `GET /regressions/{uuid}`: `detail` by default. */
  respond?: () => Response | Promise<Response>
  detail?: Regression
}

/** The page at `url`, that of `DETAIL` or `detail` by default, with what it reads mocked. */
function renderRegression({
  url = PAGE,
  suites,
  machines = ['linux', 'macos'],
  detail = DETAIL,
  respond = () => HttpResponse.json(detail),
}: Options = {}) {
  const calls = { count: 0 }
  mockSuites(suites)
  mockMachines(() => ({ items: machines.map((name) => machine(name)) }))
  mockResolve([TAGGED, PLAIN])
  mockCommits((query) => {
    const text = query.get('search') ?? ''
    const exact = query.get('commit')
    return cursorPage(
      [TAGGED, PLAIN].filter(
        (c) => c.value.includes(text) && (exact === null || c.value === exact),
      ),
    )
  })
  server.use(
    mockApi('get', ROUTE, () => {
      calls.count++
      return respond()
    }),
  )
  renderPage(url)
  return calls
}

/** `base` once `body` is applied, as the API answers a PATCH. */
function patched(body: Schemas['RegressionUpdate'], base = DETAIL): Regression {
  return { ...base, ...body }
}

const stateButton = () => selectButton('State')
const deleteButton = () => screen.getByRole('button', { name: 'Delete regression' })
const heading = () => screen.getByRole('heading', { level: 1 })

/** The value of the info box's row `label`, once the box shows it as `expected`. */
async function expectRow(label: string, expected: string) {
  await waitFor(async () =>
    expect(Object.fromEntries(await infoRows('Regression'))[label]).toBe(expected),
  )
}

describe('the Regression Detail page', () => {
  it('shows the regression, labelled, with its title as the heading', async () => {
    renderRegression()

    // The commit by its display value, once resolved.
    await expectRow('Commit', 'r100 (v1)Edit')
    const rows = await infoRows('Regression')
    expect(rows.map(([label]) => label)).toEqual([
      'Title',
      'State',
      'Bug',
      'Commit',
      'Created',
      'Notes',
    ])
    expect(Object.fromEntries(rows)).toMatchObject({
      Title: 'find_if slowdownEdit',
      Bug: 'https://bugs.example/1Edit',
      Created: formatTimestamp(DETAIL.created_at),
      Notes: 'Bisected.\nOnly x86.Edit',
    })
    expect(stateButton()).toHaveTextContent('active')
    expect(heading()).toHaveTextContent('Regression: find_if slowdown')
    expect(main().getByRole('link', { name: 'https://bugs.example/1' })).toHaveAttribute(
      'target',
      '_blank',
    )
    expect(main().getByRole('link', { name: 'r100 (v1)' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/abc123',
    )
  })

  it('shows what is not set as such, and a regression without a title by its UUID', async () => {
    renderRegression({
      detail: { ...DETAIL, title: null, bug: null, commit: null, notes: null },
    })

    const rows = Object.fromEntries(await infoRows('Regression'))
    expect([rows.Title, rows.Bug, rows.Commit, rows.Notes]).toEqual(Array(4).fill('--Edit'))
    expect(heading()).toHaveTextContent('Regression: aaaaaaaa…')
  })

  it('shows a bug that is not a web URL as text', async () => {
    renderRegression({ detail: { ...DETAIL, bug: 'javascript:alert(1)' } })

    await expectRow('Bug', 'javascript:alert(1)Edit')
    expect(main().queryByRole('link', { name: /javascript/ })).not.toBeInTheDocument()
  })

  it('shows only the error for a regression that does not exist, with no retry', async () => {
    renderRegression({
      respond: () => errorResponse(404, 'not_found', `Regression '${UUID}' not found`),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    expect(screen.queryByRole('group', { name: 'Regression' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(heading()).toHaveTextContent('Regression: aaaaaaaa…')
  })

  it('offers to fetch the regression again when it could not be', async () => {
    let fail = true
    renderRegression({
      respond: () =>
        fail ? errorResponse(500, 'internal_error', 'Boom') : HttpResponse.json(DETAIL),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Boom')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('group', { name: 'Regression' })).toBeInTheDocument()
  })

  it('asks for nothing of a suite that does not exist', async () => {
    const calls = { count: 0 }
    mockSuites([])
    server.use(
      mockApi('get', ROUTE, () => {
        calls.count++
        return HttpResponse.json(DETAIL)
      }),
    )
    renderPage(PAGE)

    expect(await screen.findByRole('alert')).toHaveTextContent("Test suite 'libcxx' not found")
    expect(calls.count).toBe(0)
  })

  it('cannot be changed or deleted without triage scope, and says why', async () => {
    signIn('submit')
    renderRegression()

    await screen.findByRole('group', { name: 'Regression' })
    const controls = [
      ...['Title', 'Bug', 'Commit', 'Notes'].map(editButton),
      stateButton(),
      deleteButton(),
    ]
    const why = /'triage' scope.*has the 'submit' scope/
    for (const control of controls) {
      await waitFor(() => expect(control).toBeDisabled())
      expect(control.closest('[title]')).toHaveAttribute('title', expect.stringMatching(why))
    }
    // The dropdown's reason is not on the button itself, so it is given as its description.
    expect(stateButton()).toHaveAccessibleDescription(why)
  })

  describe('its title, bug and notes', () => {
    it('are changed with PATCH, sent with the token, shown once the API accepts them', async () => {
      signIn('triage')
      const answer = gate()
      const sent = mockSent('patch', ROUTE, async (body) => {
        await answer.promise
        return HttpResponse.json(patched(body))
      })
      renderRegression()
      await ready('Regression', () => editButton('Title'))

      save('Title', ' memchr slowdown ')

      expect(await screen.findByRole('button', { name: 'Saving...' })).toBeInTheDocument()
      // Not even in the heading before the API has accepted it.
      expect(heading()).toHaveTextContent('Regression: find_if slowdown')
      act(() => answer.open())
      await expectRow('Title', 'memchr slowdownEdit')
      expect(heading()).toHaveTextContent('Regression: memchr slowdown')
      expect(sent).toEqual([{ body: { title: 'memchr slowdown' }, auth: `Bearer ${TOKEN}` }])
    })

    it('are cleared when emptied', async () => {
      signIn('triage')
      const sent = mockSent('patch', ROUTE, (body) => HttpResponse.json(patched(body)))
      renderRegression()
      await ready('Regression', () => editButton('Bug'))

      save('Bug', '  ')

      await expectRow('Bug', '--Edit')
      expect(sent.map(({ body }) => body)).toEqual([{ bug: null }])
    })

    it('are bounded in length, as the API bounds the title and the bug', async () => {
      signIn('triage')
      renderRegression()
      await ready('Regression', () => editButton('Title'))

      for (const field of ['Title', 'Bug']) {
        fireEvent.click(editButton(field))
        expect(screen.getByRole('textbox', { name: field })).toHaveAttribute('maxLength', '256')
        fireEvent.keyDown(screen.getByRole('textbox', { name: field }), { key: 'Escape' })
      }
    })

    it('edit the notes on several lines, saved with Cmd+Enter', async () => {
      signIn('triage')
      const sent = mockSent('patch', ROUTE, (body) => HttpResponse.json(patched(body)))
      renderRegression()
      await ready('Regression', () => editButton('Notes'))

      fireEvent.click(editButton('Notes'))
      const notes = screen.getByRole('textbox', { name: 'Notes' })
      expect(notes).toHaveValue('Bisected.\nOnly x86.')
      fireEvent.change(notes, { target: { value: 'Line 1\nLine 2' } })
      fireEvent.keyDown(notes, { key: 'Enter', metaKey: true })

      await expectRow('Notes', 'Line 1\nLine 2Edit')
      expect(sent.map(({ body }) => body)).toEqual([{ notes: 'Line 1\nLine 2' }])
    })

    it('report a change the API refuses, keeping the editor open with its text', async () => {
      signIn('triage')
      mockSent('patch', ROUTE, () => errorResponse(400, 'invalid_request', 'Title is too long'))
      renderRegression()
      await ready('Regression', () => editButton('Title'))

      save('Title', 'x')

      expect(await screen.findByRole('alert')).toHaveTextContent('Title is too long')
      expect(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('x')
    })
  })

  describe('its commit', () => {
    /**
     * Open the commit's editor on `detail`, as a holder of a triage key, with each PATCH answered
     * by `respond`, at once by default.
     */
    async function editCommit(
      detail = DETAIL,
      respond: (body: Schemas['RegressionUpdate']) => Response | Promise<Response> = (body) =>
        HttpResponse.json(patched(body, detail)),
    ) {
      signIn('triage')
      const sent = mockSent('patch', ROUTE, respond)
      renderRegression({ detail })
      await ready('Regression', () => editButton('Commit'))
      fireEvent.click(editButton('Commit'))
      const picker = screen.getByRole('combobox', { name: 'Commit' })
      return { sent, picker, user: userEvent.setup() }
    }

    it('is picked among every commit of the suite, by display value, and saved', async () => {
      const { sent, picker, user } = await editCommit({ ...DETAIL, commit: null })
      expect(picker).toHaveFocus()

      await user.type(picker, 'def')
      await user.click(await screen.findByRole('option', { name: 'def456' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await expectRow('Commit', 'def456Edit')
      expect(sent.map(({ body }) => body)).toEqual([{ commit: 'def456' }])
    })

    it('is saved with Enter once picked', async () => {
      const { sent, picker, user } = await editCommit()
      await waitFor(() => expect(picker).toHaveValue('r100 (v1)'))

      await user.clear(picker)
      await user.type(picker, 'def456{Enter}')
      expect(picker).toHaveValue('def456')
      expect(sent).toEqual([])
      await user.keyboard('{Enter}')

      await expectRow('Commit', 'def456Edit')
      expect(sent.map(({ body }) => body)).toEqual([{ commit: 'def456' }])
    })

    it('is cleared when the picker is emptied', async () => {
      const { sent, user } = await editCommit()

      await user.click(screen.getByRole('button', { name: 'Clear Commit' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      await expectRow('Commit', '--Edit')
      expect(sent.map(({ body }) => body)).toEqual([{ commit: null }])
    })

    it('is not saved while the picker holds text that was not picked, and says why', async () => {
      const { sent, picker, user } = await editCommit()

      await user.clear(picker)
      await user.type(picker, 'nope')
      // Hidden from assistive technology, and so not found by role, while the list is open.
      const saveButton = screen.getByText('Save', { selector: 'button' })
      expect(saveButton).toHaveAttribute('aria-disabled', 'true')
      expect(saveButton).toHaveAccessibleDescription(
        'Pick a commit from the list, or clear the field.',
      )
      await user.click(saveButton)
      fireEvent.submit(picker)

      expect(sent).toEqual([])
      expect(picker).toBeInTheDocument()
    })

    it('closes the list on Escape, and the editor on the next one', async () => {
      const { sent, picker, user } = await editCommit()

      await user.type(picker, 'x')
      expect(await screen.findByRole('listbox')).toBeInTheDocument()
      await user.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument())
      expect(picker).toBeInTheDocument()

      await user.keyboard('{Escape}')
      await expectRow('Commit', 'r100 (v1)Edit')
      expect(editButton('Commit')).toHaveFocus()
      expect(sent).toEqual([])
    })

    it('cannot be changed while it is being saved', async () => {
      const answer = gate()
      const { picker, user } = await editCommit(DETAIL, async (body) => {
        await answer.promise
        return HttpResponse.json(patched(body))
      })
      await user.click(screen.getByRole('button', { name: 'Clear Commit' }))
      await user.click(screen.getByRole('button', { name: 'Save' }))

      expect(await screen.findByRole('button', { name: 'Saving...' })).toBeInTheDocument()
      expect(picker).toHaveAttribute('readOnly')
      act(() => answer.open())
      await expectRow('Commit', '--Edit')
    })
  })

  describe('its state', () => {
    it('is saved as soon as another is picked, and shown once the API accepts it', async () => {
      signIn('triage')
      const answer = gate()
      const sent = mockSent('patch', ROUTE, async (body) => {
        await answer.promise
        return HttpResponse.json(patched(body))
      })
      renderRegression()
      await ready('Regression', stateButton)
      const user = userEvent.setup()

      await user.click(stateButton())
      await user.click(await screen.findByRole('option', { name: 'fixed' }))

      expect(sent).toEqual([{ body: { state: 'fixed' }, auth: `Bearer ${TOKEN}` }])
      // Not optimistic, and not opened meanwhile, though it keeps the focus.
      expect(stateButton()).toHaveTextContent('active')
      expect(stateButton()).toHaveAttribute('aria-disabled', 'true')
      expect(stateButton()).not.toBeDisabled()
      await user.click(stateButton())
      expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
      act(() => answer.open())
      await waitFor(() => expect(stateButton()).toHaveTextContent('fixed'))
      expect(sent).toHaveLength(1)
    })

    it('is not changed by the keys that step through the options of the closed dropdown', async () => {
      signIn('triage')
      const sent = mockSent('patch', ROUTE, (body) => HttpResponse.json(patched(body)))
      renderRegression()
      await ready('Regression', stateButton)
      const user = userEvent.setup()

      stateButton().focus()
      await user.keyboard('{ArrowRight}{ArrowLeft}f')

      expect(stateButton()).toHaveTextContent('active')
      expect(sent).toEqual([])
    })

    it('reports a change the API refuses, still showing the stored state', async () => {
      signIn('triage')
      mockSent('patch', ROUTE, () => errorResponse(403, 'forbidden', 'No'))
      renderRegression()
      await ready('Regression', stateButton)
      const user = userEvent.setup()

      await user.click(stateButton())
      await user.click(await screen.findByRole('option', { name: 'fixed' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Permission denied')
      expect(stateButton()).toHaveTextContent('active')
    })
  })

  it('saves changes one after the other, so that the later answer is the one shown', async () => {
    signIn('triage')
    const first = gate()
    const order: string[] = []
    let stored = DETAIL
    mockSent('patch', ROUTE, async (body) => {
      order.push(Object.keys(body)[0])
      if ('title' in body) await first.promise
      stored = { ...stored, ...body }
      return HttpResponse.json(stored)
    })
    renderRegression()
    await ready('Regression', () => editButton('Title'))
    const user = userEvent.setup()

    save('Title', 'memchr slowdown')
    await user.click(stateButton())
    await user.click(await screen.findByRole('option', { name: 'fixed' }))
    // The state's request waits for the title's answer.
    await waitFor(() => expect(order).toEqual(['title']))
    act(() => first.open())

    await waitFor(() => expect(stateButton()).toHaveTextContent('fixed'))
    await expectRow('Title', 'memchr slowdownEdit')
    expect(order).toEqual(['title', 'state'])
  })

  it('is shown changed by the Regressions tab, once fetched again', async () => {
    signIn('triage')
    let stored = DETAIL
    mockSent('patch', ROUTE, (body) => {
      stored = { ...stored, ...body }
      return HttpResponse.json(stored)
    })
    renderRegression({ url: '/suites/libcxx?tab=regressions' })
    mockMachines(() => ({ items: [] }))
    const lists = mockRegressions(() => cursorPage([{ ...regression('a'), title: stored.title }]))
    fireEvent.click(await screen.findByRole('link', { name: 'find_if slowdown' }))
    await ready('Regression', () => editButton('Title'))

    save('Title', 'memchr slowdown')
    await expectRow('Title', 'memchr slowdownEdit')
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

    expect(await screen.findByRole('link', { name: 'memchr slowdown' })).toBeInTheDocument()
    expect(lists).toHaveLength(2)
  })

  describe('Delete regression', () => {
    it('is confirmed by typing the start of the UUID, then shows the Regressions tab', async () => {
      signIn('triage')
      const deletion = gate()
      const deleted: (string | null)[] = []
      server.use(
        mockApi('delete', ROUTE, async ({ request }) => {
          deleted.push(request.headers.get('Authorization'))
          await deletion.promise
          return new HttpResponse(null, { status: 204 })
        }),
      )
      const calls = renderRegression()
      await ready('Regression', deleteButton)
      mockRegressions()
      mockMachines(() => ({ items: [] }))

      fireEvent.click(deleteButton())
      const prompt = screen.getByRole('form', { name: 'Confirmation' })
      expect(prompt).toHaveTextContent('Type aaaaaaaa to confirm')
      expect(prompt).toHaveTextContent('find_if slowdown and its 2 indicators')
      fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: 'aaaaaaaa' } })
      fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))
      act(() => deletion.open())

      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=regressions'))
      expect(deleted).toEqual([`Bearer ${TOKEN}`])
      expect(await screen.findByText('No regressions yet.')).toBeInTheDocument()
      // The deleted regression is not asked for again on the way out.
      expect(calls.count).toBe(1)
    })
  })
})

/** The tests with a value for the metric on each machine, as `GET tests` lists them, unsorted. */
const TESTS: Record<string, string[]> = { linux: ['b', 'a'], macos: ['c', 'a'] }

/** Answer `GET tests` with the tests of the machine asked for; returns the queries. */
function mockMachineTests(tests = TESTS) {
  return mockTests((query) =>
    cursorPage((tests[query.get('machine')!] ?? []).map((name) => ({ name }))),
  )
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name })
const addButton = () => screen.getByRole('button', { name: /^Add/ })
const list = (name: string) => screen.getByRole('group', { name: new RegExp(`^${name}`) })
const preview = () => within(panel()).getAllByRole('status')[0]
const panel = () => screen.getByRole('region', { name: 'Add indicators' })

/** The names a checkbox list shows, in order. */
function namesIn(name: string) {
  return within(list(name))
    .queryAllByRole('checkbox')
    .slice(1)
    .map((box) => box.getAttribute('aria-label'))
}

/** Click the checkboxes of `names` in turn. */
async function pick(...names: string[]) {
  const user = userEvent.setup()
  for (const name of names) await user.click(checkbox(name))
}

describe('the Add indicators panel', () => {
  it('lists the machines, and the tests of those selected on the metric, merged and sorted', async () => {
    const queries = mockMachineTests()
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))
    expect(selectButton('Metric')).toHaveTextContent('Execution Time')
    expect(list('Tests')).toHaveTextContent('Select one or more machines first.')

    await pick('linux')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b']))
    await pick('macos')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b', 'c']))

    // Each machine's tests are asked for once, on the metric.
    expect(queries.map((query) => [query.get('machine'), query.get('metric')])).toEqual([
      ['linux', 'execution_time'],
      ['macos', 'execution_time'],
    ])
  })

  it('previews and adds an indicator for each machine and test, then says what was added', async () => {
    signIn('triage')
    mockMachineTests()
    const sent = mockSent('post', `${ROUTE}/indicators`, () =>
      HttpResponse.json({
        added: 3,
        indicators: [
          ...DETAIL.indicators,
          { uuid: uuidOf('3'), machine: 'linux', test: 'a', metric: 'execution_time' },
        ],
      }),
    )
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))

    await pick('linux', 'macos')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b', 'c']))
    await pick('a', 'b')
    expect(preview()).toHaveTextContent('This will add 4 indicators.')
    expect(list('Tests')).toHaveTextContent('(2 of 3 tests selected)')
    await waitFor(() => expect(addButton()).toBeEnabled())
    fireEvent.click(addButton())

    expect(await within(panel()).findByText(/^Added 3 indicators/)).toHaveTextContent(
      'Added 3 indicators. 1 indicator already existed.',
    )
    expect(sent).toEqual([
      {
        auth: `Bearer ${TOKEN}`,
        body: {
          indicators: [
            { machine: 'linux', test: 'a', metric: 'execution_time' },
            { machine: 'linux', test: 'b', metric: 'execution_time' },
            { machine: 'macos', test: 'a', metric: 'execution_time' },
            { machine: 'macos', test: 'b', metric: 'execution_time' },
          ],
        },
      },
    ])
    // The tests added are deselected, and the table shows what the API answered.
    expect(list('Tests')).toHaveTextContent('(0 of 3 tests selected)')
    expect(rowsOf(await table('Indicators'))).toHaveLength(3)
  })

  it('keeps what its filter hides selected, and says so', async () => {
    mockMachineTests()
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))
    await pick('linux')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b']))
    await pick('a')

    search('Filter tests', 'b')

    await waitFor(() => expect(namesIn('Tests')).toEqual(['b']))
    expect(list('Tests')).toHaveTextContent('(1 of 2 tests selected, 1 hidden by the filter)')
    expect(preview()).toHaveTextContent('This will add 1 indicator.')
  })

  it('deselects the tests no longer offered, once the tests are listed', async () => {
    mockMachineTests()
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))
    await pick('macos')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'c']))
    await pick('a', 'c')

    await pick('linux', 'macos')

    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b']))
    expect(list('Tests')).toHaveTextContent('(1 of 2 tests selected)')
    expect(checkbox('a')).toBeChecked()
  })

  it('selects a range of tests with Shift held, and every test shown at once', async () => {
    mockMachineTests({ linux: ['a', 'b', 'c', 'd'] })
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))
    await pick('linux')
    await waitFor(() => expect(namesIn('Tests')).toHaveLength(4))
    const user = userEvent.setup()

    await user.click(checkbox('a'))
    await user.keyboard('{Shift>}')
    await user.click(checkbox('c'))
    await user.keyboard('{/Shift}')
    expect(list('Tests')).toHaveTextContent('(3 of 4 tests selected)')

    await user.click(checkbox('Select all tests shown'))
    expect(list('Tests')).toHaveTextContent('(4 of 4 tests selected)')
  })

  it('cannot add while the tests are not all listed, and offers to list them again', async () => {
    signIn('triage')
    let fail = true
    server.use(
      mockApi('get', '/api/suites/{testsuite}/tests', ({ request }) => {
        const machine = new URL(request.url).searchParams.get('machine')!
        if (machine === 'linux' && fail) return errorResponse(500, 'internal_error', 'Boom')
        return HttpResponse.json(cursorPage(TESTS[machine].map((name) => ({ name }))))
      }),
    )
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))
    await pick('macos')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'c']))
    await pick('c', 'linux', 'macos')

    expect(await within(list('Tests')).findByRole('alert')).toHaveTextContent('Boom')
    expect(addButton()).toBeDisabled()
    expect(addButton()).toHaveAttribute('title', 'The tests are not listed yet.')
    // What was selected stays selected, since no list shows that it is no longer offered.
    expect(preview()).toHaveTextContent('This will add 1 indicator.')

    fail = false
    fireEvent.click(within(list('Tests')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b']))
    // Now listed, the tests show that `c` is not offered on linux.
    expect(list('Tests')).toHaveTextContent('(0 of 2 tests selected)')
    expect(preview()).toHaveTextContent('This will add 0 indicators.')
  })

  it('cannot add more indicators than one request can carry', async () => {
    signIn('triage')
    // 11 machines and 910 tests: 10010 indicators.
    const machines = Array.from({ length: 11 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const names = Array.from({ length: 910 }, (_, i) => `t${String(i).padStart(3, '0')}`)
    mockMachineTests(Object.fromEntries(machines.map((name) => [name, names])))
    renderRegression({ machines })
    await waitFor(() => expect(namesIn('Machines')).toHaveLength(11))

    fireEvent.click(checkbox('Select all machines shown'))
    await waitFor(() => expect(list('Tests')).toHaveTextContent('of 910 tests'))
    fireEvent.click(checkbox('Select all tests shown'))

    expect(preview()).toHaveTextContent(
      'This will add 10010 indicators, more than the 10000 one request can carry.',
    )
    await waitFor(() =>
      expect(addButton()).toHaveAttribute('title', expect.stringMatching(/at most 10000/)),
    )
    expect(addButton()).toBeDisabled()
  })

  it('cannot add without triage scope, but can be browsed', async () => {
    signIn('submit')
    mockMachineTests()
    renderRegression()
    await waitFor(() => expect(namesIn('Machines')).toEqual(['linux', 'macos']))

    await pick('linux')
    await waitFor(() => expect(namesIn('Tests')).toEqual(['a', 'b']))
    await pick('a')

    await waitFor(() =>
      expect(addButton()).toHaveAttribute('title', expect.stringMatching(/'triage' scope/)),
    )
    expect(addButton()).toBeDisabled()
  })

  it('says why a suite offers nothing to add', async () => {
    renderRegression({ suites: [{ ...SUITE, metrics: [] }], machines: [] })

    await screen.findByRole('region', { name: 'Add indicators' })
    expect(await within(panel()).findByText('This suite has no machines.')).toBeInTheDocument()
    expect(list('Tests')).toHaveTextContent('This suite has no metrics.')
    expect(within(panel()).queryByRole('button', { name: /Metric$/ })).not.toBeInTheDocument()
  })
})

/** A suite with a metric that is not numeric, as well as `SUITE`'s. */
const WITH_TEXT: SuiteSchema = {
  ...SUITE,
  metrics: [
    ...SUITE.metrics,
    {
      name: 'status',
      type: 'text',
      display_name: 'Status',
      unit: null,
      unit_abbrev: null,
      bigger_is_better: false,
    },
  ],
}

/** Indicators on two machines, two tests and two metrics, oldest first. */
const INDICATORS: Schemas['Indicator'][] = [
  { uuid: uuidOf('1'), machine: 'linux', test: 'BM_find', metric: 'execution_time' },
  { uuid: uuidOf('2'), machine: 'linux', test: 'BM_sort', metric: 'execution_time' },
  { uuid: uuidOf('3'), machine: 'macos', test: 'BM_find', metric: 'execution_time' },
  { uuid: uuidOf('4'), machine: 'macos', test: 'BM_find', metric: 'status' },
]
const WITH_INDICATORS = { ...DETAIL, indicators: INDICATORS }

const removeButton = (row: string) => screen.getByRole('button', { name: `Remove ${row}` })

describe('the Indicators table', () => {
  it('lists the indicators, oldest first, with links to their machine and the Graph page', async () => {
    renderRegression({ detail: WITH_INDICATORS, suites: [WITH_TEXT] })

    const indicators = await table('Indicators')
    expect(screen.getByRole('heading', { level: 2, name: /^Indicators/ })).toHaveTextContent(
      'Indicators (2 tests across 2 machines across 2 metrics)',
    )
    expect(rowsOf(indicators)).toEqual([
      ' | linux | BM_find | Execution Time | View on graph | ×',
      ' | linux | BM_sort | Execution Time | View on graph | ×',
      ' | macos | BM_find | Execution Time | View on graph | ×',
      ' | macos | BM_find | Status | View on graph | ×',
    ])
    expect(within(indicators).getAllByRole('link', { name: 'linux' })[0]).toHaveAttribute(
      'href',
      '/suites/libcxx/machines/linux',
    )
    const graphs = within(indicators).getAllByRole('link', { name: 'View on graph' })
    expect(graphs[1]).toHaveAttribute(
      'href',
      '/graph?suite=libcxx&machine=linux&metric=execution_time&test=BM_sort&regressions=all',
    )
    // The Graph page plots only numeric metrics.
    expect(graphs[3]).not.toHaveAttribute('href')
    expect(graphs[3]).toHaveAttribute('aria-disabled', 'true')
    expect(graphs[3]).toHaveAttribute('title', 'The Graph page only plots numeric metrics.')
  })

  it('says when there are none, with no filter', async () => {
    renderRegression({ detail: { ...DETAIL, indicators: [] } })

    expect(await screen.findByText('This regression has no indicators.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 2, name: 'Indicators' })).toBeInTheDocument()
    expect(screen.queryByRole('searchbox', { name: 'Filter indicators' })).not.toBeInTheDocument()
  })

  it('is filtered by machine, test or metric label, kept in the URL', async () => {
    renderRegression({ detail: WITH_INDICATORS, suites: [WITH_TEXT] })
    const indicators = await table('Indicators')

    search('Filter indicators', 'status')

    await waitFor(() => expect(rowsOf(indicators)).toHaveLength(1))
    expect(screen.getByRole('heading', { level: 2, name: /^Indicators/ })).toHaveTextContent(
      'Indicators (showing 1 of 2 tests across 1 of 2 machines across 1 of 2 metrics)',
    )
    await waitFor(() => expect(currentUrl()).toBe(`${PAGE}?indicator_filter=status`))
  })

  it('deselects the rows its filter hides', async () => {
    signIn('triage')
    renderRegression({ detail: WITH_INDICATORS })
    await table('Indicators')
    fireEvent.click(checkbox('Select all indicators shown'))
    expect(screen.getByRole('button', { name: 'Remove 4 selected' })).toBeInTheDocument()

    search('Filter indicators', 'macos')

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Remove 2 selected' })).toBeInTheDocument(),
    )
  })

  it('removes one indicator, then focuses the remove button of the row in its place', async () => {
    signIn('triage')
    const sent = mockSent('delete', `${ROUTE}/indicators`, ({ indicator_uuids }) =>
      HttpResponse.json({
        removed: 1,
        indicators: INDICATORS.filter((indicator) => !indicator_uuids.includes(indicator.uuid)),
      }),
    )
    renderRegression({ detail: WITH_INDICATORS })
    const indicators = await table('Indicators')
    const row = 'linux, BM_sort, Execution Time'
    await waitFor(() => expect(removeButton(row)).toBeEnabled())

    fireEvent.click(removeButton(row))

    await waitFor(() => expect(rowsOf(indicators)).toHaveLength(3))
    expect(sent.map(({ body }) => body)).toEqual([{ indicator_uuids: [uuidOf('2')] }])
    await waitFor(() => expect(removeButton('macos, BM_find, Execution Time')).toHaveFocus())
  })

  it('focuses the row before the last one removed, and the table once none is left', async () => {
    signIn('triage')
    let stored = INDICATORS.slice(2)
    mockSent('delete', `${ROUTE}/indicators`, ({ indicator_uuids }) => {
      stored = stored.filter((indicator) => !indicator_uuids.includes(indicator.uuid))
      return HttpResponse.json({ removed: 1, indicators: stored })
    })
    renderRegression({ detail: { ...DETAIL, indicators: stored }, suites: [WITH_TEXT] })
    const indicators = await table('Indicators')
    await waitFor(() => expect(removeButton('macos, BM_find, Status')).toBeEnabled())

    // The last row: the row before it takes the focus.
    fireEvent.click(removeButton('macos, BM_find, Status'))
    await waitFor(() => expect(removeButton('macos, BM_find, Execution Time')).toHaveFocus())

    fireEvent.click(removeButton('macos, BM_find, Execution Time'))
    await waitFor(() => expect(indicators).toHaveFocus())
  })

  it('removes the indicators selected, a range of them selected with Shift', async () => {
    signIn('triage')
    const sent = mockSent('delete', `${ROUTE}/indicators`, ({ indicator_uuids }) =>
      HttpResponse.json({
        removed: indicator_uuids.length,
        indicators: INDICATORS.filter((indicator) => !indicator_uuids.includes(indicator.uuid)),
      }),
    )
    renderRegression({ detail: WITH_INDICATORS, suites: [WITH_TEXT] })
    const indicators = await table('Indicators')
    const user = userEvent.setup()

    await user.click(checkbox('Select linux, BM_sort, Execution Time'))
    await user.keyboard('{Shift>}')
    await user.click(checkbox('Select macos, BM_find, Status'))
    await user.keyboard('{/Shift}')
    const removeSelected = screen.getByRole('button', { name: 'Remove 3 selected' })
    await waitFor(() => expect(removeSelected).toBeEnabled())
    fireEvent.click(removeSelected)

    await waitFor(() => expect(rowsOf(indicators)).toHaveLength(1))
    expect(sent.map(({ body }) => body)).toEqual([
      { indicator_uuids: [uuidOf('2'), uuidOf('3'), uuidOf('4')] },
    ])
    expect(screen.getByRole('button', { name: 'Remove selected' })).toBeDisabled()
    await waitFor(() => expect(indicators).toHaveFocus())
  })

  it('cannot remove without triage scope, and says why', async () => {
    signIn('submit')
    renderRegression({ detail: WITH_INDICATORS })
    await table('Indicators')
    fireEvent.click(checkbox('Select all indicators shown'))

    for (const button of [
      removeButton('linux, BM_find, Execution Time'),
      screen.getByRole('button', { name: 'Remove 4 selected' }),
    ]) {
      await waitFor(() =>
        expect(button).toHaveAttribute('title', expect.stringMatching(/'triage' scope/)),
      )
      expect(button).toBeDisabled()
    }
  })

  it('drops its filter from the URL when the regression has no indicators', async () => {
    renderRegression({ detail: { ...DETAIL, indicators: [] }, url: `${PAGE}?indicator_filter=x` })

    await screen.findByText('This regression has no indicators.')
    await waitFor(() => expect(currentUrl()).toBe(PAGE))
  })
})
