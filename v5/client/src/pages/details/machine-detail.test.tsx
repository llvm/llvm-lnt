import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { PERMISSION_DENIED, type Schemas } from '../../api/client'
import { signIn, TOKEN } from '../../test/auth'
import { commit, cursorPage, machine, regression, run, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  infoRows,
  mockMachines,
  mockResolve,
  mockSuites,
  recording,
  renderPage,
  rowsOf,
  table,
} from '../../test/page'
import { server } from '../../test/server'

const NAME = 'linux-x86_64'
const PAGE = `/suites/libcxx/machines/${NAME}`
const LINUX = machine(NAME, { fields: { hardware: 'AMD EPYC', os: null, core_count: 64 } })

type Respond = (query: URLSearchParams) => Response | Promise<Response>

const MACHINE_ROUTE = '/api/suites/{testsuite}/machines/{machine_name}'

interface PageMocks {
  /** The answer to `GET /machines/{name}`: `LINUX` by default. */
  machine?: () => Response
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
    mockApi('get', MACHINE_ROUTE, () => {
      machineCalls.count++
      return machine()
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

/** Wait for the info box, and the token's check, which enables what `manage` scope allows. */
async function ready(control: () => HTMLElement) {
  await screen.findByRole('group', { name: 'Machine' })
  await waitFor(() => expect(control()).toBeEnabled())
}

function trackedBox() {
  return screen.getByRole('checkbox', { name: 'Tracked' })
}

function deleteButton() {
  return screen.getByRole('button', { name: 'Delete Machine' })
}

/** Queries within the page's content, rather than the navbar, which has a Compare link too. */
function main() {
  return within(screen.getByRole('main'))
}

describe('the Machine Detail page', () => {
  it('shows the machine, its tracked flag and its fields, labelled', async () => {
    renderMachine()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Machine: ${NAME}`)
    const rows = await infoRows('Machine')
    expect(rows[0][0]).toBe('Tracked')
    expect(rows.slice(1)).toEqual([
      ['Hardware', 'AMD EPYC'],
      ['os', '--'],
      ['Cores', '64'],
    ])
    expect(trackedBox()).toBeChecked()
  })

  it('explains the tracked flag, on hover and to assistive technology', async () => {
    renderMachine()

    await screen.findByRole('group', { name: 'Machine' })
    expect(trackedBox()).toHaveAccessibleDescription(/Dashboard.*kept indefinitely/)
    expect(screen.getByText('Tracked')).toHaveAttribute(
      'title',
      expect.stringMatching(/Dashboard.*kept indefinitely/),
    )
  })

  it('shows an untracked machine unchecked', async () => {
    mockPage({ machine: () => HttpResponse.json({ ...LINUX, tracked: false }) })
    renderPage(PAGE)

    await screen.findByRole('group', { name: 'Machine' })
    expect(trackedBox()).not.toBeChecked()
  })

  it('says when the suite does not exist', async () => {
    mockSuites()
    renderPage('/suites/nope/machines/x')

    expect(await screen.findByRole('alert')).toHaveTextContent("Test suite 'nope' not found.")
  })

  it('shows only the error for a machine that does not exist, with no retry', async () => {
    const { regressionQueries, runQueries } = mockPage({
      machine: () => errorResponse(404, 'not_found', "Machine 'x' not found in test suite 'libcxx'"),
    })
    renderPage('/suites/libcxx/machines/x')

    expect(await screen.findByRole('alert')).toHaveTextContent("Machine 'x' not found")
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Run History' })).not.toBeInTheDocument()
    expect(regressionQueries).toEqual([])
    expect(runQueries).toEqual([])
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
        expect(trackedBox()).toHaveAttribute('title', expect.stringMatching(/'manage' scope/)),
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
      await ready(trackedBox)

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

    it('reports a refused change, and keeps the flag as it was', async () => {
      signIn('manage')
      mockPatch(() => errorResponse(403, 'forbidden', 'Insufficient scope'))
      renderMachine()
      await ready(trackedBox)

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
      await ready(trackedBox)

      fireEvent.click(trackedBox())
      await waitFor(() => expect(trackedBox()).not.toBeChecked())
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      expect(await within(await table('Machines')).findByText('untracked')).toBeInTheDocument()
      expect(machineQueries).toHaveLength(2)
    })
  })

  describe('Delete Machine', () => {
    it('needs manage scope', async () => {
      signIn('triage')
      renderMachine()

      await screen.findByRole('group', { name: 'Machine' })
      await waitFor(() =>
        expect(deleteButton()).toHaveAttribute('title', expect.stringMatching(/'manage' scope/)),
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
      await ready(deleteButton)
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
      await ready(deleteButton)
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

    it('can be cancelled, giving the focus back to the button', async () => {
      signIn('manage')
      renderMachine()
      await ready(deleteButton)

      fireEvent.click(deleteButton())
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

      expect(screen.queryByRole('form', { name: 'Confirmation' })).not.toBeInTheDocument()
      expect(deleteButton()).toHaveFocus()
    })
  })

  describe('its active regressions', () => {
    it('are those detected or active on the machine, newest first', async () => {
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
        'find_if slowdown | active | 12',
        `${'x'.repeat(49)}… | detected | 1`,
        '(untitled) | detected | 0',
      ])
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

      expect(rowsOf(await table('Active regressions'))).toEqual(['find_if slowdown | detected | 0'])
    })
  })

  describe('its run history', () => {
    it('lists the runs newest first, with their commits by display value, a page at a time', async () => {
      const { runQueries } = renderMachine({ runs: [run('a', { commit: 'abc123' })] })

      const runs = await table('Run history')
      expect(rowsOf(runs)).toEqual([
        `${uuidOf('a').slice(0, 8)}… | r100 (v1) | 2026-08-25, 2:22:41 PM`,
      ])
      expect(Object.fromEntries(runQueries[0])).toEqual({
        machine: NAME,
        sort: '-submitted_at',
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
