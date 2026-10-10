import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { formatTimestamp } from '../../format'
import { signIn, TOKEN } from '../../test/auth'
import { commit, cursorPage, regression, regressionDetail, uuidOf } from '../../test/fixtures'
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
  mockSuites,
  ready,
  renderPage,
  save,
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
  /** The answer to `GET /regressions/{uuid}`: `detail` by default. */
  respond?: () => Response | Promise<Response>
  detail?: Regression
}

/** The page at `url`, that of `DETAIL` or `detail` by default, with what it reads mocked. */
function renderRegression({
  url = PAGE,
  detail = DETAIL,
  respond = () => HttpResponse.json(detail),
}: Options = {}) {
  const calls = { count: 0 }
  mockSuites()
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

/** Answer `PATCH /regressions/{uuid}` with `respond`, recording the bodies and headers it got. */
function mockPatch(respond: (body: Schemas['RegressionUpdate']) => Response | Promise<Response>) {
  const sent: { body: Schemas['RegressionUpdate']; auth: string | null }[] = []
  server.use(
    mockApi('patch', ROUTE, async ({ request }) => {
      const body = await request.json()
      sent.push({ body, auth: request.headers.get('Authorization') })
      return respond(body)
    }),
  )
  return sent
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
      const sent = mockPatch(async (body) => {
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
      const sent = mockPatch((body) => HttpResponse.json(patched(body)))
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
      const sent = mockPatch((body) => HttpResponse.json(patched(body)))
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
      mockPatch(() => errorResponse(400, 'invalid_request', 'Title is too long'))
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
      const sent = mockPatch(respond)
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
      const sent = mockPatch(async (body) => {
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
      const sent = mockPatch((body) => HttpResponse.json(patched(body)))
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
      mockPatch(() => errorResponse(403, 'forbidden', 'No'))
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
    mockPatch(async (body) => {
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
    mockPatch((body) => {
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
