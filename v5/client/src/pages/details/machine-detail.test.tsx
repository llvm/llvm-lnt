import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { useNavigate } from 'react-router'
import { describe, expect, it } from 'vitest'
import App from '../../app'
import { PERMISSION_DENIED, type Schemas } from '../../api/client'
import { INACTIVITY_HELP } from '../../inactivity'
import { machinePath } from '../../paths'
import { signIn, TOKEN } from '../../test/auth'
import { commit, cursorPage, machine, regression, run, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  editButton,
  gate,
  inactivityCell,
  infoRows,
  main,
  mockMachines,
  mockResolve,
  mockSent,
  mockSuites,
  ready,
  recording,
  renderPage,
  rowsOf,
  save,
  settle,
  table,
  trailLink,
  typeInto,
} from '../../test/page'
import { renderWithProviders } from '../../test/render'
import { server } from '../../test/server'

const NAME = 'linux-x86_64'
const PAGE = `/suites/libcxx/machines/${NAME}`
const LINUX = machine(NAME, { fields: { hardware: 'AMD EPYC', os: null, core_count: 64 } })

type Respond = (query: URLSearchParams) => Response | Promise<Response>

const MACHINE_ROUTE = '/api/suites/{testsuite}/machines/{machine_name}'

interface PageMocks {
  /** The answer to `GET /machines/{name}`, given the request and the name: `LINUX` by default. */
  machine?: (request: Request, name: string) => Response
  regressions?: Respond
  runs?: Respond
}

/**
 * Mock what the page for `NAME` reads: the suites, the machine, its lists, which are empty unless
 * given, and the display value of the commit `abc123`. Returns how many times the machine was asked
 * for, and the queries of the lists.
 */
function mockPage({
  machine = () => HttpResponse.json(LINUX),
  regressions = () => HttpResponse.json(cursorPage([])),
  runs = () => HttpResponse.json(cursorPage([])),
}: PageMocks = {}) {
  const machineCalls = { count: 0 }
  const regressionList = recording(regressions)
  const runList = recording(runs)
  mockSuites()
  mockResolve([
    commit('abc123', { tag: 'v1', fields: { svn_revision: 'r100', commit_info: null } }),
  ])
  server.use(
    mockApi('get', MACHINE_ROUTE, ({ request, params }) => {
      machineCalls.count++
      return machine(request, params.machine_name)
    }),
    mockApi('get', '/api/suites/{testsuite}/regressions', ({ request }) =>
      regressionList.answer(request),
    ),
    mockApi('get', '/api/suites/{testsuite}/runs', ({ request }) => runList.answer(request)),
  )
  return { machineCalls, regressionQueries: regressionList.queries, runQueries: runList.queries }
}

/** The page for `NAME`, listing `regressions` and `runs`, the latter followed by a second page. */
function renderMachine({
  regressions = [] as Schemas['Regression'][],
  runs = [] as Schemas['Run'][],
} = {}) {
  const mocks = mockPage({
    regressions: () => HttpResponse.json(cursorPage(regressions)),
    runs: (query) =>
      HttpResponse.json(
        query.has('cursor')
          ? cursorPage([run('f')])
          : cursorPage(runs, runs.length > 0 ? 'p2' : null),
      ),
  })
  renderPage(PAGE)
  return mocks
}

/** Answer `PATCH /machines/{name}` with `respond`. */
function mockPatch(respond: (request: Request) => Response | Promise<Response>) {
  server.use(mockApi('patch', MACHINE_ROUTE, ({ request }) => respond(request)))
}

/** Answer `DELETE /machines/{name}` with `respond`, a 204 by default. */
function mockDelete(
  respond: (request: Request) => Response | Promise<Response> = () =>
    new HttpResponse(null, { status: 204 }),
) {
  server.use(mockApi('delete', MACHINE_ROUTE, ({ request }) => respond(request)))
}

function trackedBox() {
  return screen.getByRole('checkbox', { name: 'Tracked' })
}

function deleteButton() {
  return screen.getByRole('button', { name: 'Delete Machine' })
}

describe('the Machine Detail page', () => {
  it('shows the machine, its name, its tracked flag and its fields, labelled', async () => {
    renderMachine()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Machine: ${NAME}`)
    const rows = await infoRows('Machine')
    expect(rows[0][0]).toBe('Name')
    expect(rows[0][1]).toMatch(new RegExp(`^${NAME}Edit`))
    expect(rows[1][0]).toBe('Tracked')
    expect(rows[2]).toEqual(['Delete after inactivity', inactivityCell('--')])
    expect(rows.slice(3)).toEqual([
      ['Hardware', 'AMD EPYC'],
      ['os', '--'],
      ['Cores', '64'],
    ])
    expect(trackedBox()).toBeChecked()
  })

  it('shows a machine whose name holds characters that a URL escapes', async () => {
    const name = 'a b?c#d&e+ü'
    const requested: string[] = []
    mockPage({
      machine: (request) => {
        requested.push(new URL(request.url).pathname)
        return HttpResponse.json(machine(name))
      },
    })
    renderPage(machinePath('libcxx', name))

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Machine: ${name}`)
    await screen.findByRole('group', { name: 'Machine' })
    expect(requested).toEqual([`/api/suites/libcxx/machines/${encodeURIComponent(name)}`])
  })

  it('explains the tracked flag, on hover and to assistive technology', async () => {
    renderMachine()

    await screen.findByRole('group', { name: 'Machine' })
    const help =
      "Untracked machines are left out of the Dashboard's trend overview, and listed after the " +
      'tracked ones wherever a machine is picked, but are usable everywhere.'
    expect(trackedBox()).toHaveAccessibleDescription(help)
    expect(screen.getByText('Tracked')).toHaveAttribute('title', help)
  })

  it('shows an untracked machine unchecked', async () => {
    mockPage({ machine: () => HttpResponse.json({ ...LINUX, tracked: false }) })
    renderPage(PAGE)

    await screen.findByRole('group', { name: 'Machine' })
    expect(trackedBox()).not.toBeChecked()
  })

  it('says when the suite does not exist, with the trail', async () => {
    mockSuites()
    renderPage('/suites/nope/machines/x')

    expect(await screen.findByRole('alert')).toHaveTextContent("Test suite 'nope' not found.")
    expect(trailLink('Machines')).toHaveAttribute('href', '/suites/nope?tab=machines')
  })

  it('shows only the error for a machine that does not exist, with no retry, and the trail', async () => {
    const { regressionQueries, runQueries } = mockPage({
      machine: () => errorResponse(404, 'not_found', "Machine 'x' not found in test suite 'libcxx'"),
    })
    renderPage('/suites/libcxx/machines/x')

    expect(await screen.findByRole('alert')).toHaveTextContent("Machine 'x' not found")
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Run History' })).not.toBeInTheDocument()
    expect(regressionQueries).toEqual([])
    expect(runQueries).toEqual([])
    expect(trailLink('Machines')).toHaveAttribute('href', '/suites/libcxx?tab=machines')
  })

  it('offers to fetch the machine again when it could not be', async () => {
    let fail = true
    const { machineCalls } = mockPage({
      machine: () =>
        fail ? errorResponse(500, 'internal_error', 'Boom') : HttpResponse.json(LINUX),
    })
    renderPage(PAGE)

    expect(await screen.findByRole('alert')).toHaveTextContent('Boom')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('group', { name: 'Machine' })).toBeInTheDocument()
    expect(machineCalls.count).toBe(2)
  })

  it('links to the Graph and Compare pages for the machine', async () => {
    renderMachine()

    expect(await main().findByRole('link', { name: 'View Graph' })).toHaveAttribute(
      'href',
      `/graph?suite=libcxx&machine=${NAME}`,
    )
    expect(main().getByRole('link', { name: 'Compare' })).toHaveAttribute(
      'href',
      `/compare?suite_a=libcxx&machine_a=${NAME}`,
    )
  })

  describe('its tracked flag', () => {
    it('cannot be changed without manage scope', async () => {
      signIn('triage')
      renderMachine()

      await screen.findByRole('group', { name: 'Machine' })
      await waitFor(() =>
        expect(trackedBox()).toHaveAttribute('title', expect.stringMatching(/has the 'triage' scope/)),
      )
      expect(trackedBox()).toBeDisabled()
    })

    it('is changed with PATCH, sent with the token, and shows what the API answered', async () => {
      signIn('manage')
      const answer = gate()
      const sent: { body: unknown; auth: string | null }[] = []
      mockPatch(async (request) => {
        sent.push({ body: await request.json(), auth: request.headers.get('Authorization') })
        await answer.promise
        return HttpResponse.json({ ...LINUX, tracked: false })
      })
      renderMachine()
      await ready('Machine', trackedBox)

      trackedBox().focus()
      fireEvent.click(trackedBox())

      // Under way: still checked, ignoring clicks, and keeping the focus.
      await waitFor(() => expect(trackedBox()).toHaveAttribute('aria-disabled', 'true'))
      expect(trackedBox()).toBeChecked()
      expect(trackedBox()).toHaveFocus()
      fireEvent.click(trackedBox())
      act(() => answer.open())

      await waitFor(() => expect(trackedBox()).not.toBeChecked())
      expect(trackedBox()).not.toHaveAttribute('aria-disabled')
      expect(sent).toEqual([{ body: { tracked: false }, auth: `Bearer ${TOKEN}` }])
    })

    it('is not changed by a click on its label, which explains it', async () => {
      signIn('manage')
      const sent: unknown[] = []
      mockPatch(async (request) => {
        sent.push(await request.json())
        return HttpResponse.json(LINUX)
      })
      renderMachine()
      await ready('Machine', trackedBox)

      fireEvent.click(screen.getByText('Tracked'))

      expect(trackedBox()).toBeChecked()
      expect(sent).toEqual([])
    })

    it('reports a refused change, and keeps the flag as it was', async () => {
      signIn('manage')
      mockPatch(() => errorResponse(403, 'forbidden', 'Insufficient scope'))
      renderMachine()
      await ready('Machine', trackedBox)

      fireEvent.click(trackedBox())

      expect(await screen.findByRole('alert')).toHaveTextContent(PERMISSION_DENIED)
      expect(trackedBox()).toBeChecked()
    })

    it('is fetched again by the machine list once changed', async () => {
      signIn('manage')
      let tracked = true
      mockPatch(() => {
        tracked = false
        return HttpResponse.json({ ...LINUX, tracked })
      })
      mockPage()
      const machineQueries = mockMachines(() => ({ items: [{ ...LINUX, tracked }] }))
      // From the Machines tab, whose list is then cached.
      renderPage('/suites/libcxx?tab=machines')
      fireEvent.click(within(await table('Machines')).getByRole('link', { name: NAME }))
      await ready('Machine', trackedBox)

      fireEvent.click(trackedBox())
      await waitFor(() => expect(trackedBox()).not.toBeChecked())
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      expect(await within(await table('Machines')).findByText('untracked')).toBeInTheDocument()
      expect(machineQueries).toHaveLength(2)
    })
  })

  describe('its deletion after inactivity', () => {
    const row = async () => (await infoRows('Machine'))[2]

    it('cannot be changed without manage scope', async () => {
      signIn('triage')
      renderMachine()

      await screen.findByRole('group', { name: 'Machine' })
      await waitFor(() =>
        expect(editButton('Delete after inactivity')).toHaveAttribute(
          'title',
          expect.stringMatching(/has the 'triage' scope/),
        ),
      )
      expect(editButton('Delete after inactivity')).toBeDisabled()
    })

    it('shows the days, explaining them on hover and to assistive technology', async () => {
      signIn('manage')
      mockPage({
        machine: () => HttpResponse.json({ ...LINUX, delete_after_inactive_days: 30 }),
      })
      renderPage(PAGE)

      expect(await row()).toEqual(['Delete after inactivity', inactivityCell('30 days')])
      await waitFor(() => expect(editButton('Delete after inactivity')).toBeEnabled())
      expect(screen.getByText('Delete after inactivity')).toHaveAttribute('title', INACTIVITY_HELP)
      expect(editButton('Delete after inactivity')).toHaveAccessibleDescription(INACTIVITY_HELP)
    })

    it('is changed with PATCH, sent with the token, and cleared when emptied', async () => {
      signIn('manage')
      const sent = mockSent('patch', MACHINE_ROUTE, (body) =>
        HttpResponse.json({ ...LINUX, ...body }),
      )
      renderMachine()
      await ready('Machine', () => editButton('Delete after inactivity'))

      save('Delete after inactivity', '1')
      await waitFor(async () =>
        expect(await row()).toEqual(['Delete after inactivity', inactivityCell('1 day')]),
      )
      save('Delete after inactivity', ' ')
      await waitFor(async () =>
        expect(await row()).toEqual(['Delete after inactivity', inactivityCell('--')]),
      )

      expect(sent).toEqual([
        { body: { delete_after_inactive_days: 1 }, auth: `Bearer ${TOKEN}` },
        { body: { delete_after_inactive_days: null }, auth: `Bearer ${TOKEN}` },
      ])
    })
  })

  describe('its name', () => {
    const NEW = 'macos-arm64'
    const NEW_PAGE = machinePath('libcxx', NEW)
    const nameInput = () => screen.getByRole('textbox', { name: 'Name' })
    const heading = () => screen.getByRole('heading', { level: 1 })
    const back = () => fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    const prompt = () => screen.getByRole('form', { name: 'Confirmation' })

    /** Save the name `text`, and confirm it. */
    function rename(text: string) {
      save('Name', text)
      fireEvent.click(within(prompt()).getByRole('button', { name: 'OK' }))
    }

    /** Answer a rename with the machine renamed, once `wait` resolves; returns what was sent. */
    function mockRename(wait?: Promise<void>) {
      return mockSent('patch', MACHINE_ROUTE, async (body) => {
        await wait
        return HttpResponse.json({ ...LINUX, ...body })
      })
    }

    it('cannot be changed without manage scope', async () => {
      signIn('triage')
      renderMachine()

      await screen.findByRole('group', { name: 'Machine' })
      await waitFor(() =>
        expect(editButton('Name')).toHaveAttribute(
          'title',
          expect.stringMatching(/has the 'triage' scope/),
        ),
      )
      expect(editButton('Name')).toBeDisabled()
    })

    it('asks to confirm a new name, saying what it means for submissions, before sending it', async () => {
      signIn('manage')
      const sent = mockRename()
      renderMachine()
      await ready('Machine', () => editButton('Name'))

      save('Name', ` ${NEW} `)

      expect(prompt()).toHaveTextContent(
        `Rename ${NAME} to ${NEW}? Run submissions that still use the name ${NAME} will create a ` +
          'new machine, so whatever submits runs for this machine must be updated too.',
      )
      expect(within(prompt()).getByRole('button', { name: 'Cancel' })).toHaveFocus()
      // The input waits for the answer, unchanged.
      expect(nameInput()).toHaveAttribute('readonly')
      expect(screen.getByRole('button', { name: 'Save' })).toHaveAttribute('aria-disabled', 'true')
      await settle()
      expect(sent).toEqual([])
    })

    it('is not sent once its confirmation is cancelled, with Cancel or Escape, which goes back to the input', async () => {
      signIn('manage')
      const sent = mockRename()
      renderMachine()
      await ready('Machine', () => editButton('Name'))
      const cancels = [
        () => fireEvent.click(within(prompt()).getByRole('button', { name: 'Cancel' })),
        () => fireEvent.keyDown(within(prompt()).getByRole('button', { name: 'Cancel' }), {
          key: 'Escape',
        }),
      ]

      fireEvent.click(editButton('Name'))
      for (const cancel of cancels) {
        typeInto(nameInput(), ` ${NEW} `)
        fireEvent.submit(nameInput())
        cancel()

        expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
        expect(nameInput()).toHaveValue(` ${NEW} `)
        expect(nameInput()).toHaveFocus()
        expect(nameInput()).not.toHaveAttribute('readonly')
      }
      await settle()
      expect(sent).toEqual([])
    })

    it('closes without asking anything when the name is unchanged', async () => {
      signIn('manage')
      const sent = mockRename()
      renderMachine()
      await ready('Machine', () => editButton('Name'))

      save('Name', ` ${NAME} `)

      expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
      expect(sent).toEqual([])
    })

    it('cannot be saved empty, nor as a name that no URL could address', async () => {
      signIn('manage')
      const sent = mockRename()
      renderMachine()
      await ready('Machine', () => editButton('Name'))

      fireEvent.click(editButton('Name'))
      expect(nameInput()).toHaveAttribute('maxLength', '256')
      const empty = 'A machine needs a name.'
      const unaddressable = "A machine name cannot contain '/' or '%', or be '.' or '..'."
      const reasons = {
        '': empty,
        ' ': empty,
        'a/b': unaddressable,
        'a%b': unaddressable,
        '.': unaddressable,
        '..': unaddressable,
      }
      for (const [text, reason] of Object.entries(reasons)) {
        typeInto(nameInput(), text)
        expect(nameInput()).toHaveAttribute('aria-invalid', 'true')
        expect(nameInput()).toHaveAccessibleDescription(expect.stringContaining(reason))
        expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
        fireEvent.submit(nameInput())
      }
      typeInto(nameInput(), '...')
      expect(nameInput()).not.toHaveAttribute('aria-invalid')
      expect(sent).toEqual([])
    })

    it('is changed with PATCH, then shown on the page of the new name, in place of the old', async () => {
      signIn('manage')
      const answer = gate()
      const sent = mockRename(answer.promise)
      const { machineCalls, regressionQueries, runQueries } = mockPage()
      mockMachines(() => ({ items: [LINUX] }))
      // From the Machines tab, whose list is then cached.
      renderPage('/suites/libcxx?tab=machines')
      fireEvent.click(within(await table('Machines')).getByRole('link', { name: NAME }))
      await ready('Machine', () => editButton('Name'))
      const machineQueries = mockMachines(() => ({ items: [machine(NEW)] }))

      rename(` ${NEW} `)

      // Under way: the page still shows the old name, and the input, which has the focus back.
      await waitFor(() => expect(sent).toHaveLength(1))
      expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
      expect(nameInput()).toHaveFocus()
      expect(heading()).toHaveTextContent(`Machine: ${NAME}`)
      expect(currentUrl()).toBe(PAGE)
      act(() => answer.open())

      await waitFor(() => expect(currentUrl()).toBe(NEW_PAGE))
      expect(heading()).toHaveTextContent(`Machine: ${NEW}`)
      expect((await infoRows('Machine'))[0][1]).toMatch(new RegExp(`^${NEW}Edit`))
      await waitFor(() => expect(editButton('Name')).toHaveFocus())
      expect(sent).toEqual([{ body: { name: NEW }, auth: `Bearer ${TOKEN}` }])
      // The machine is shown as the API returned it, rather than asked for again, and its lists are
      // asked for under its new name.
      expect(machineCalls.count).toBe(1)
      await waitFor(() => expect(regressionQueries.at(-1)!.get('machine')).toBe(NEW))
      await waitFor(() => expect(runQueries.at(-1)!.get('machine')).toBe(NEW))

      // Back leaves for the page before, whose list, read before the rename, is not shown.
      back()
      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines'))
      expect(screen.queryByRole('link', { name: NAME })).not.toBeInTheDocument()
      expect(await within(await table('Machines')).findByRole('link', { name: NEW })).toBeVisible()
      expect(machineQueries).toHaveLength(1)
    })

    it('keeps showing the runs until those under the new name arrive', async () => {
      signIn('manage')
      mockRename()
      const runs = gate()
      mockPage({
        runs: async (query) => {
          const renamed = query.get('machine') === NEW
          if (renamed) await runs.promise
          return HttpResponse.json(cursorPage([run(renamed ? 'b' : 'a')]))
        },
      })
      renderPage(PAGE)
      await ready('Machine', () => editButton('Name'))
      const history = await table('Run history')

      rename(NEW)

      await waitFor(() => expect(currentUrl()).toBe(NEW_PAGE))
      expect(rowsOf(history)[0]).toMatch(/^aaaaaaaa…/)
      expect(history).toHaveAttribute('aria-busy', 'true')
      act(() => runs.open())
      await waitFor(() => expect(rowsOf(history)[0]).toMatch(/^bbbbbbbb…/))
    })

    it('is not kept by the page of another machine that the page goes to in place', async () => {
      signIn('manage')
      const other = 'other-machine'
      mockPage({ machine: (_, name) => HttpResponse.json(name === NAME ? LINUX : machine(name)) })
      // Nothing in the app goes from one machine's page to another's in place, but the history
      // could, so the test does it itself: to `NAME`'s page, then back to `other`'s, cached.
      function GoTo() {
        const navigate = useNavigate()
        return [PAGE, machinePath('libcxx', other)].map((to) => (
          <button key={to} onClick={() => navigate(to)}>
            Go to {to}
          </button>
        ))
      }
      renderWithProviders(
        <>
          <App />
          <GoTo />
        </>,
        { url: machinePath('libcxx', other) },
      )
      await ready('Machine', deleteButton)
      fireEvent.click(screen.getByRole('button', { name: `Go to ${PAGE}` }))
      await waitFor(() => expect(heading()).toHaveTextContent(`Machine: ${NAME}`))
      await ready('Machine', deleteButton)
      fireEvent.click(deleteButton())
      expect(screen.getByRole('form', { name: 'Confirmation' })).toBeInTheDocument()

      fireEvent.click(screen.getByRole('button', { name: `Go to ${machinePath('libcxx', other)}` }))

      expect(heading()).toHaveTextContent(`Machine: ${other}`)
      expect(screen.getByRole('group', { name: 'Machine' })).toBeInTheDocument()
      expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
    })

    it('stays open with its text when the name is taken, saying so', async () => {
      signIn('manage')
      const taken = "A machine named 'other' already exists in test suite 'libcxx'"
      mockPatch(() => errorResponse(409, 'duplicate', taken))
      renderMachine()
      await ready('Machine', () => editButton('Name'))

      rename('other')

      expect(await screen.findByRole('alert')).toHaveTextContent(taken)
      expect(nameInput()).toHaveValue('other')
      expect(currentUrl()).toBe(PAGE)
      expect(heading()).toHaveTextContent(`Machine: ${NAME}`)
    })

    it('is not shown under its old name when the history leads back to its page', async () => {
      signIn('manage')
      let renamed = false
      mockPatch(() => {
        renamed = true
        return HttpResponse.json(machine(NEW))
      })
      mockPage({
        machine: (_, name) => {
          if (name === NEW) return HttpResponse.json(machine(NEW))
          return renamed
            ? errorResponse(404, 'not_found', `Machine '${NAME}' not found`)
            : HttpResponse.json(LINUX)
        },
        runs: () => HttpResponse.json(cursorPage([run('a', { machine: renamed ? NEW : NAME })])),
      })
      mockMachines(() => ({ items: [] }))
      // The machine's page, then the Runs tab, then the machine's page again, from its run's row.
      renderPage(PAGE)
      await ready('Machine', () => editButton('Name'))
      fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
      fireEvent.click(within(await table('Runs')).getByRole('link', { name: NAME }))
      await ready('Machine', () => editButton('Name'))

      rename(NEW)
      await waitFor(() => expect(currentUrl()).toBe(NEW_PAGE))
      back()
      back()

      expect(currentUrl()).toBe(PAGE)
      expect(screen.queryByRole('group', { name: 'Machine' })).not.toBeInTheDocument()
      expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    })

    it('does not leave a page the user has already left, and refreshes the one shown', async () => {
      signIn('manage')
      const answer = gate()
      const sent = mockRename(answer.promise)
      const { runQueries } = renderMachine()
      await ready('Machine', () => editButton('Name'))
      rename(NEW)
      await waitFor(() => expect(sent).toHaveLength(1))

      // To the Runs tab of the suite, which lists the machine's runs, while the rename runs.
      fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
      await table('Runs')
      const fetched = runQueries.length
      act(() => answer.open())

      await waitFor(() => expect(runQueries.length).toBe(fetched + 1))
      expect(currentUrl()).toBe('/suites/libcxx')
    })
  })

  describe('Delete Machine', () => {
    it('needs manage scope', async () => {
      signIn('triage')
      renderMachine()

      await screen.findByRole('group', { name: 'Machine' })
      await waitFor(() =>
        expect(deleteButton()).toHaveAttribute(
          'title',
          expect.stringMatching(/has the 'triage' scope/),
        ),
      )
      expect(deleteButton()).toBeDisabled()
    })

    it('is confirmed by typing the name, says it may take a while, then shows the machines left', async () => {
      signIn('manage')
      const deletion = gate()
      const deleted: (string | null)[] = []
      mockDelete(async (request) => {
        deleted.push(request.headers.get('Authorization'))
        await deletion.promise
        return new HttpResponse(null, { status: 204 })
      })
      renderMachine()
      await ready('Machine', deleteButton)
      mockMachines(() => ({ items: [] }))

      fireEvent.click(deleteButton())
      const prompt = screen.getByRole('form', { name: 'Confirmation' })
      expect(prompt).toHaveTextContent(`Type ${NAME} to confirm`)
      expect(prompt).toHaveTextContent(/regression indicator naming it/)
      fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: NAME } })
      fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

      expect(await within(prompt).findByText(/may take a while/)).toBeInTheDocument()
      act(() => deletion.open())
      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines'))
      expect(deleted).toEqual([`Bearer ${TOKEN}`])
      expect(await screen.findByText('No machines yet.')).toBeInTheDocument()
    })

    /** Delete `NAME`, from its page, reached by its link on the Machines tab at `from`. */
    async function deleteFrom(from: string) {
      signIn('manage')
      mockDelete()
      mockPage()
      mockMachines(() => ({ items: [LINUX] }))
      renderPage(from)
      fireEvent.click(within(await table('Machines')).getByRole('link', { name: NAME }))
      await ready('Machine', deleteButton)
      // Once deleted, the machine is no longer listed.
      const machineQueries = mockMachines(() => ({ items: [] }))

      fireEvent.click(deleteButton())
      fireEvent.change(screen.getByRole('textbox'), { target: { value: NAME } })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines'))
      return machineQueries
    }

    it('does not show the machine in the list cached before', async () => {
      const machineQueries = await deleteFrom('/suites/libcxx?tab=machines')

      expect(screen.queryByRole('link', { name: NAME })).not.toBeInTheDocument()
      expect(await screen.findByText('No machines yet.')).toBeInTheDocument()
      expect(machineQueries).toHaveLength(1)
    })

    it('leaves the page in place of itself in the history', async () => {
      // From a search, so that the page before the machine's is not the one it leaves for.
      await deleteFrom('/suites/libcxx?tab=machines&search=linux')

      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines&search=linux'))
    })

    it('does not show the machine from the cache when the history leads back to its page', async () => {
      signIn('manage')
      mockDelete()
      let gone = false
      mockPage({
        machine: () =>
          gone
            ? errorResponse(404, 'not_found', `Machine '${NAME}' not found`)
            : HttpResponse.json(LINUX),
        runs: () => HttpResponse.json(cursorPage(gone ? [] : [run('a')])),
      })
      mockMachines(() => ({ items: [] }))
      // The machine's page, then the Runs tab, then the machine's page again, from its run's row.
      const { queryClient } = renderPage(PAGE)
      await ready('Machine', deleteButton)
      fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
      fireEvent.click(within(await table('Runs')).getByRole('link', { name: NAME }))

      await startDeleting()
      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines'))
      // Nothing the page read is kept, its lists included, rather than only the machine itself.
      await waitFor(() =>
        expect(queryClient.getQueryCache().findAll({ queryKey: ['suite', 'libcxx'] })).toEqual([
          expect.objectContaining({ queryKey: ['suite', 'libcxx', 'machines', {}] }),
        ]),
      )
      gone = true
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      expect(currentUrl()).toBe(PAGE)
      expect(screen.queryByRole('group', { name: 'Machine' })).not.toBeInTheDocument()
      expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    })

    /** Start deleting `NAME` from its page, confirmed. */
    async function startDeleting() {
      await ready('Machine', deleteButton)
      fireEvent.click(deleteButton())
      fireEvent.change(screen.getByRole('textbox'), { target: { value: NAME } })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    }

    it('reports a deletion that failed, and stays on the page', async () => {
      signIn('manage')
      mockDelete(() => errorResponse(500, 'internal_error', 'Could not delete'))
      renderMachine()

      await startDeleting()

      expect(await screen.findByRole('alert')).toHaveTextContent('Could not delete')
      expect(currentUrl()).toBe(PAGE)
      expect(screen.getByRole('group', { name: 'Machine' })).toBeInTheDocument()
    })

    it('does not leave a page the user has already left, and refreshes the one shown', async () => {
      signIn('manage')
      const deletion = gate()
      mockDelete(async () => {
        await deletion.promise
        return new HttpResponse(null, { status: 204 })
      })
      const { runQueries } = renderMachine()
      await startDeleting()

      // To the Runs tab of the suite, which lists the machine's runs, while the deletion runs.
      fireEvent.click(screen.getByRole('link', { name: 'Test Suites' }))
      await table('Runs')
      const fetched = runQueries.length
      act(() => deletion.open())

      await waitFor(() => expect(runQueries.length).toBe(fetched + 1))
      expect(currentUrl()).toBe('/suites/libcxx')
    })

    it('can be cancelled, giving the focus back to the button', async () => {
      signIn('manage')
      renderMachine()
      await ready('Machine', deleteButton)

      fireEvent.click(deleteButton())
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
      expect(deleteButton()).toHaveFocus()
    })
  })

  describe('its active regressions', () => {
    it('are those detected or active on the machine, newest first, by UUID and title', async () => {
      const long = 'x'.repeat(60)
      const { regressionQueries } = renderMachine({
        regressions: [
          regression('a', { title: 'find_if slowdown', state: 'active', test_count: 12 }),
          regression('b', { title: long, test_count: 1 }),
          regression('c', { title: null }),
        ],
      })

      const list = await table('Active regressions')
      expect(rowsOf(list)).toEqual([
        'aaaaaaaa… | find_if slowdown | active | 12',
        `bbbbbbbb… | ${'x'.repeat(49)}… | detected | 1`,
        'cccccccc… | (untitled) | detected | 0',
      ])
      // The UUID tells the regressions without a title apart.
      const uuid = within(list).getByRole('link', { name: 'cccccccc…' })
      expect(uuid).toHaveAttribute('href', `/suites/libcxx/regressions/${uuidOf('c')}`)
      expect(uuid).toHaveAttribute('title', uuidOf('c'))
      expect(within(list).getByRole('link', { name: /^x+…$/ })).toHaveAttribute('title', long)
      const untruncated = within(list).getByRole('link', { name: 'find_if slowdown' })
      expect(untruncated).not.toHaveAttribute('title')
      expect(untruncated).toHaveAttribute('href', `/suites/libcxx/regressions/${uuidOf('a')}`)
      expect(regressionQueries).toHaveLength(1)
      const query = regressionQueries[0]
      expect(query.get('machine')).toBe(NAME)
      expect(query.getAll('state')).toEqual(['detected', 'active'])
      expect(query.get('sort')).toBe('-created_at')
      expect(query.get('limit')).toBe('25')
    })

    it('say when there are none, still linking to all the machine’s regressions', async () => {
      renderMachine()

      expect(await screen.findByText('No active regressions on this machine.')).toBeInTheDocument()
      expect(screen.getByRole('link', { name: 'Show all regressions' })).toHaveAttribute(
        'href',
        `/suites/libcxx?tab=regressions&machine=${NAME}`,
      )
    })

    it('give way to the error when they cannot be fetched, with a retry', async () => {
      let fail = true
      mockPage({
        regressions: () =>
          fail
            ? errorResponse(500, 'internal_error', 'Regressions unavailable')
            : HttpResponse.json(cursorPage([regression('a')])),
      })
      renderPage(PAGE)

      expect(await screen.findByRole('alert')).toHaveTextContent('Regressions unavailable')
      expect(screen.queryByRole('table', { name: 'Active regressions' })).not.toBeInTheDocument()
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(rowsOf(await table('Active regressions'))).toEqual([
        'aaaaaaaa… | find_if slowdown | detected | 0',
      ])
    })
  })

  describe('its run history', () => {
    it('lists the runs most recently measured first, with their commits by display value, a page at a time', async () => {
      const { runQueries } = renderMachine({ runs: [run('a', { commit: 'abc123' })] })

      const runs = await table('Run history')
      expect(rowsOf(runs)).toEqual([
        `${uuidOf('a').slice(0, 8)}… | r100 (v1) | 2026-08-25, 2:02:17 PM`,
      ])
      expect(Object.fromEntries(runQueries[0])).toEqual({
        machine: NAME,
        sort: '-measured_at',
        limit: '25',
      })

      fireEvent.click(screen.getByRole('button', { name: /Next/ }))

      await waitFor(() => expect(rowsOf(runs)[0]).toMatch(/^ffffffff…/))
      expect(runQueries.at(-1)!.get('cursor')).toBe('p2')
    })

    it('says when the machine has no runs', async () => {
      renderMachine()

      expect(await screen.findByText('No runs on this machine yet.')).toBeInTheDocument()
    })

    it('gives way to the error when a page cannot be fetched, with a retry', async () => {
      let fail = true
      mockPage({
        runs: (query) => {
          if (!query.has('cursor')) {
            return HttpResponse.json(cursorPage([run('a')], 'p2'))
          }
          return fail
            ? errorResponse(500, 'internal_error', 'Runs unavailable')
            : HttpResponse.json(cursorPage([run('b')]))
        },
      })
      renderPage(PAGE)
      await table('Run history')

      fireEvent.click(screen.getByRole('button', { name: /Next/ }))

      expect(await screen.findByRole('alert')).toHaveTextContent('Runs unavailable')
      expect(screen.queryByRole('table', { name: 'Run history' })).not.toBeInTheDocument()
      expect(screen.queryByRole('navigation', { name: 'Run history pagination' })).toBeNull()
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      await waitFor(async () => expect(rowsOf(await table('Run history'))[0]).toMatch(/^bbbbbbbb…/))
    })
  })
})
