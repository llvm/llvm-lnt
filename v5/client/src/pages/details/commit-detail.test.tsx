import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { withoutNeighbours } from '../../api/commits'
import { signIn, TOKEN } from '../../test/auth'
import { commit, cursorPage, regression, run, uuidOf } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  infoRows,
  main,
  mockCommits,
  mockResolve,
  mockSuites,
  queryOf,
  ready,
  recording,
  renderPage,
  rowsOf,
  search,
  table,
  type Respond,
} from '../../test/page'
import { server } from '../../test/server'

const VALUE = 'abc123'
const PAGE = `/suites/libcxx/commits/${VALUE}`
const COMMIT_ROUTE = '/api/suites/{testsuite}/commits/{value}'

const PREVIOUS = commit('prev99', {
  ordinal: 99,
  fields: { svn_revision: 'r99', commit_info: null },
})
const NEXT = commit('next101', { ordinal: 101, tag: 'v2' })
const DETAIL: Schemas['CommitDetail'] = {
  ...commit(VALUE, {
    ordinal: 100,
    tag: 'v1',
    fields: { svn_revision: 'r100', commit_info: 'Fix the vectorizer' },
  }),
  previous: PREVIOUS,
  next: NEXT,
}
/** The commit before `VALUE` on any machine, as its lookup finds it. */
const BEFORE = commit('before', { ordinal: 98 })

interface Options {
  url?: string
  /** The answer to `GET /commits/{value}`: `DETAIL` by default. */
  detail?: () => Response | Promise<Response>
  /** The answer to each request for runs; by default, `runs` on one page. */
  runPages?: Respond<Response>
  runs?: Schemas['Run'][]
  /** The answer to each request for regressions; by default, none. */
  regressions?: Respond<Response>
  /** The answer to the lookup of the commit before this one on a machine. */
  previous?: Respond<Response>
}

/**
 * The page at `url`, `VALUE`'s by default, with what it reads mocked. Returns the queries of the
 * lists and lookups, and the commits each `commits/resolve` asked for.
 */
function renderCommit({
  url = PAGE,
  detail = () => HttpResponse.json(DETAIL),
  runs = [],
  runPages = () => HttpResponse.json(cursorPage(runs)),
  regressions = () => HttpResponse.json(cursorPage([])),
  previous = () => HttpResponse.json(cursorPage([BEFORE])),
}: Options = {}) {
  const detailCalls = { count: 0 }
  const runList = recording(runPages)
  const regressionList = recording(regressions)
  const lookups = recording(previous)
  mockSuites()
  const resolved = mockResolve([withoutNeighbours(DETAIL)])
  server.use(
    mockApi('get', COMMIT_ROUTE, () => {
      detailCalls.count++
      return detail()
    }),
    mockApi('get', '/api/suites/{testsuite}/runs', ({ request }) => runList.answer(request)),
    mockApi('get', '/api/suites/{testsuite}/regressions', ({ request }) =>
      regressionList.answer(request),
    ),
    mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => lookups.answer(request)),
  )
  renderPage(url)
  return {
    detailCalls,
    runQueries: runList.queries,
    regressionQueries: regressionList.queries,
    lookups: lookups.queries,
    resolved,
  }
}

/** Answer `PATCH /commits/{value}` with `respond`, recording the bodies and headers it got. */
function mockPatch(respond: (body: Schemas['CommitUpdate']) => Response | Promise<Response>) {
  const sent: { body: Schemas['CommitUpdate']; auth: string | null }[] = []
  server.use(
    mockApi('patch', COMMIT_ROUTE, async ({ request }) => {
      const body = await request.json()
      sent.push({ body, auth: request.headers.get('Authorization') })
      return respond(body)
    }),
  )
  return sent
}

/** The commit `DETAIL` becomes once `body` is applied, as the API answers a PATCH. */
function patched(body: Schemas['CommitUpdate']): Schemas['CommitDetail'] {
  return { ...DETAIL, ...body }
}

const editButton = (field: string) => screen.getByRole('button', { name: `Edit ${field}` })
const deleteButton = () => screen.getByRole('button', { name: 'Delete commit' })

/** Edit `field`, typing `text`, and save it. */
function save(field: string, text: string) {
  fireEvent.click(editButton(field))
  const input = screen.getByRole('textbox', { name: field })
  fireEvent.change(input, { target: { value: text } })
  fireEvent.submit(input)
}

/** The page's link named `name`. */
function link(name: string) {
  return main().getByRole('link', { name })
}

/** The Compare with previous link of each row of the table `runs`. */
function compareLinks(runs: HTMLElement) {
  return within(runs).getAllByRole('link', { name: 'Compare with previous' })
}

/** Wait until the row `row` of the info box shows `expected`, as its label and value. */
async function expectInfo(row: number, expected: [string, string]) {
  await waitFor(async () => expect((await infoRows('Commit'))[row]).toEqual(expected))
}

/** Runs on two machines, macos twice, in the order the API gives them: newest first. */
const RUNS = [
  run('a', { machine: 'macos', submitted_at: '2026-08-25T14:22:41Z' }),
  run('b', { machine: 'linux', submitted_at: '2026-08-25T13:00:00Z' }),
  run('c', { machine: 'macos', submitted_at: '2026-08-24T09:00:00Z' }),
]

describe('the Commit Detail page', () => {
  it('shows the commit string, its ordinal, its tag and its fields, labelled', async () => {
    renderCommit()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Commit: ${VALUE}`)
    expect(await infoRows('Commit')).toEqual([
      ['Commit', VALUE],
      ['Ordinal', '100Edit'],
      ['Tag', 'v1Edit'],
      ['svn_revision', 'r100'],
      ['commit_info', 'Fix the vectorizer'],
    ])
  })

  it('shows a missing ordinal and tag as such', async () => {
    renderCommit({
      detail: () =>
        HttpResponse.json({ ...DETAIL, ordinal: null, tag: null, previous: null, next: null }),
    })

    const rows = await infoRows('Commit')
    expect(rows[1]).toEqual(['Ordinal', '--Edit'])
    expect(rows[2]).toEqual(['Tag', '--Edit'])
  })

  it('shows only the error for a commit that does not exist, with no retry', async () => {
    renderCommit({
      detail: () => errorResponse(404, 'not_found', `Commit '${VALUE}' not found in test suite`),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Regressions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })

  it('offers to fetch the commit again when it could not be', async () => {
    let fail = true
    renderCommit({
      detail: () =>
        fail ? errorResponse(500, 'internal_error', 'Boom') : HttpResponse.json(DETAIL),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('Boom')
    fail = false
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByRole('group', { name: 'Commit' })).toBeInTheDocument()
  })

  it('fetches the runs alongside the commit', async () => {
    const answer = gate()
    const { runQueries } = renderCommit({
      detail: async () => {
        await answer.promise
        return HttpResponse.json(DETAIL)
      },
    })

    await waitFor(() => expect(runQueries).toHaveLength(1))
    expect(Object.fromEntries(runQueries[0])).toEqual({
      commit: VALUE,
      sort: '-submitted_at',
      limit: '10000',
    })
    act(() => answer.open())
    expect(await table('Runs')).toBeInTheDocument()
  })

  describe('its neighbours', () => {
    it('are linked, and named on hover by their display values', async () => {
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      expect(link('← Previous commit')).toHaveAttribute('href', '/suites/libcxx/commits/prev99')
      expect(link('← Previous commit')).toHaveAttribute('title', 'r99')
      expect(link('Next commit →')).toHaveAttribute('href', '/suites/libcxx/commits/next101')
      expect(link('Next commit →')).toHaveAttribute('title', 'next101 (v2)')
    })

    it.each<[string, Partial<Schemas['CommitDetail']>, string, string]>([
      ['first', { previous: null }, '← Previous commit', 'No commit comes before this one.'],
      ['last', { next: null }, 'Next commit →', 'No commit comes after this one.'],
    ])('are not linked from the %s commit, saying why', async (_, change, name, why) => {
      renderCommit({ detail: () => HttpResponse.json({ ...DETAIL, ...change }) })

      await screen.findByRole('group', { name: 'Commit' })
      expect(link(name)).toHaveAttribute('aria-disabled', 'true')
      expect(link(name)).not.toHaveAttribute('href')
      expect(link(name)).toHaveAccessibleDescription(why)
    })

    it('are not linked from a commit with no ordinal, saying why', async () => {
      renderCommit({
        detail: () => HttpResponse.json({ ...DETAIL, ordinal: null, previous: null, next: null }),
      })

      await screen.findByRole('group', { name: 'Commit' })
      for (const name of ['← Previous commit', 'Next commit →']) {
        expect(link(name)).not.toHaveAttribute('href')
        expect(link(name)).toHaveAttribute('title', 'This commit has no ordinal.')
      }
    })

    it('lead to a page of their own, closing what was open on this one', async () => {
      signIn('manage')
      renderCommit()
      await ready('Commit', () => editButton('Tag'))
      fireEvent.click(editButton('Tag'))
      server.use(
        mockApi('get', COMMIT_ROUTE, () =>
          HttpResponse.json({ ...PREVIOUS, previous: null, next: DETAIL }),
        ),
      )

      fireEvent.click(link('← Previous commit'))

      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx/commits/prev99'))
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Commit: prev99')
      await expectInfo(0, ['Commit', 'prev99'])
      expect(screen.queryByRole('textbox', { name: 'Tag' })).not.toBeInTheDocument()
    })
  })

  describe('its ordinal and tag', () => {
    it('cannot be edited without manage scope', async () => {
      signIn('triage')
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      for (const field of ['Ordinal', 'Tag']) {
        await waitFor(() =>
          expect(editButton(field)).toHaveAttribute(
            'title',
            expect.stringMatching(/has the 'triage' scope/),
          ),
        )
        expect(editButton(field)).toBeDisabled()
      }
    })

    it('are changed with PATCH, sent with the token, showing what the API answered', async () => {
      signIn('manage')
      const answer = gate()
      const sent = mockPatch(async (body) => {
        await answer.promise
        return HttpResponse.json({ ...patched(body), previous: BEFORE, next: null })
      })
      renderCommit()
      await ready('Commit', () => editButton('Ordinal'))

      save('Ordinal', ' 42 ')

      // Not shown before the API has accepted it.
      expect(await screen.findByRole('button', { name: 'Saving...' })).toBeInTheDocument()
      act(() => answer.open())
      await expectInfo(1, ['Ordinal', '42Edit'])
      expect(sent).toEqual([{ body: { ordinal: 42 }, auth: `Bearer ${TOKEN}` }])
      // The neighbours are those of the new ordinal.
      expect(link('← Previous commit')).toHaveAttribute('href', '/suites/libcxx/commits/before')
      expect(link('Next commit →')).not.toHaveAttribute('href')
    })

    it('do not accept an ordinal that is not an integer its column can hold', async () => {
      signIn('manage')
      const sent = mockPatch((body) => HttpResponse.json(patched(body)))
      renderCommit()
      await ready('Commit', () => editButton('Ordinal'))
      save('Ordinal', '4.5')
      const input = screen.getByRole('textbox', { name: 'Ordinal' })
      const why = 'An ordinal is an integer from -2147483648 to 2147483647.'

      // Long enough, a number becomes Infinity, which a request would send as null.
      for (const text of ['4.5', '1e3', '2147483648', '-2147483649', '9'.repeat(400)]) {
        fireEvent.change(input, { target: { value: text } })
        fireEvent.submit(input)
        expect(input).toHaveAccessibleDescription(why)
      }
      expect(sent).toEqual([])

      fireEvent.change(input, { target: { value: '-2147483648' } })
      expect(input).not.toHaveAccessibleDescription(why)
    })

    it('are cleared when emptied', async () => {
      signIn('manage')
      const sent = mockPatch((body) => HttpResponse.json(patched(body)))
      renderCommit()
      await ready('Commit', () => editButton('Tag'))

      save('Tag', '  ')

      await expectInfo(2, ['Tag', '--Edit'])
      expect(sent.map(({ body }) => body)).toEqual([{ tag: null }])
    })

    it('report a change the API refuses, keeping the editor open with its text', async () => {
      signIn('manage')
      mockPatch(() =>
        errorResponse(409, 'conflict', "Ordinal 99 is already used by commit 'prev99'"),
      )
      renderCommit()
      await ready('Commit', () => editButton('Ordinal'))

      save('Ordinal', '99')

      expect(await screen.findByRole('alert')).toHaveTextContent('already used by commit')
      expect(screen.getByRole('textbox', { name: 'Ordinal' })).toHaveValue('99')
      expect((await infoRows('Commit'))[1][1]).not.toContain('99Edit')
    })

    it('are saved one after the other, so that the later answer is the one shown', async () => {
      signIn('manage')
      const first = gate()
      const order: string[] = []
      let stored = DETAIL
      mockPatch(async (body) => {
        order.push(Object.keys(body)[0])
        if ('ordinal' in body) await first.promise
        stored = { ...stored, ...body }
        return HttpResponse.json(stored)
      })
      renderCommit()
      await ready('Commit', () => editButton('Ordinal'))

      save('Ordinal', '42')
      save('Tag', 'v9')
      // The tag's request waits for the ordinal's answer.
      await waitFor(() => expect(order).toEqual(['ordinal']))
      act(() => first.open())

      await waitFor(async () =>
        expect((await infoRows('Commit')).slice(1, 3)).toEqual([
          ['Ordinal', '42Edit'],
          ['Tag', 'v9Edit'],
        ]),
      )
      expect(order).toEqual(['ordinal', 'tag'])
    })

    it('do not fetch the runs or the regressions again once changed', async () => {
      signIn('manage')
      mockPatch((body) => HttpResponse.json(patched(body)))
      const { runQueries, regressionQueries, detailCalls } = renderCommit({ runs: RUNS })
      await table('Runs')
      await ready('Commit', () => editButton('Tag'))
      const before = [runQueries.length, regressionQueries.length, detailCalls.count]

      save('Tag', 'v9')

      await expectInfo(2, ['Tag', 'v9Edit'])
      expect([runQueries.length, regressionQueries.length, detailCalls.count]).toEqual(before)
    })

    it('look up the commit before this one on each machine again once the ordinal changes', async () => {
      signIn('manage')
      mockPatch((body) => HttpResponse.json(patched(body)))
      const { lookups } = renderCommit({ runs: RUNS })
      const runs = await table('Runs')
      await waitFor(() => expect(compareLinks(runs)[0]).toHaveAttribute('href'))
      expect(lookups).toHaveLength(2)
      await ready('Commit', () => editButton('Ordinal'))

      save('Ordinal', '42')

      await waitFor(() => expect(lookups).toHaveLength(4))
      expect(new Set(lookups.slice(2).map((query) => query.get('machine')))).toEqual(
        new Set(['linux', 'macos']),
      )
    })

    it('leave every run without a previous commit once the ordinal is cleared', async () => {
      signIn('manage')
      mockPatch((body) => HttpResponse.json({ ...patched(body), previous: null, next: null }))
      const { lookups } = renderCommit({ runs: RUNS })
      const runs = await table('Runs')
      await waitFor(() => expect(compareLinks(runs)[0]).toHaveAttribute('href'))
      await ready('Commit', () => editButton('Ordinal'))
      const looked = lookups.length

      save('Ordinal', '')

      await waitFor(() =>
        compareLinks(runs).forEach((compare) =>
          expect(compare).toHaveAttribute('title', 'This commit has no ordinal.'),
        ),
      )
      // The API refuses to look up the commit before one that has no ordinal.
      expect(lookups).toHaveLength(looked)
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('are shown changed by the commit list, once fetched again', async () => {
      signIn('manage')
      let stored: Schemas['Commit'] = withoutNeighbours(DETAIL)
      mockPatch((body) => {
        stored = { ...stored, ...body }
        return HttpResponse.json(patched(body))
      })
      renderCommit({ url: '/suites/libcxx?tab=commits' })
      const listQueries = mockCommits(() => cursorPage([stored]))
      server.use(mockApi('get', COMMIT_ROUTE, () => HttpResponse.json(DETAIL)))
      fireEvent.click(within(await table('Commits')).getByRole('link', { name: 'r100' }))
      await ready('Commit', () => editButton('Tag'))

      save('Tag', 'v9')
      await expectInfo(2, ['Tag', 'v9Edit'])
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      expect(await within(await table('Commits')).findByText('v9')).toBeInTheDocument()
      expect(listQueries).toHaveLength(2)
    })
  })

  describe('Delete commit', () => {
    it('needs manage scope', async () => {
      signIn('triage')
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      await waitFor(() =>
        expect(deleteButton()).toHaveAttribute(
          'title',
          expect.stringMatching(/has the 'triage' scope/),
        ),
      )
      expect(deleteButton()).toBeDisabled()
    })

    it('is confirmed by typing the commit, says it may take a while, then shows the commits', async () => {
      signIn('manage')
      const deletion = gate()
      const deleted: (string | null)[] = []
      server.use(
        mockApi('delete', COMMIT_ROUTE, async ({ request }) => {
          deleted.push(request.headers.get('Authorization'))
          await deletion.promise
          return new HttpResponse(null, { status: 204 })
        }),
      )
      renderCommit()
      await ready('Commit', deleteButton)
      mockCommits(() => cursorPage([]))

      fireEvent.click(deleteButton())
      const prompt = screen.getByRole('form', { name: 'Confirmation' })
      expect(prompt).toHaveTextContent(`Type ${VALUE} to confirm`)
      expect(prompt).toHaveTextContent(/all of its runs, with their samples and profiles/)
      expect(prompt).toHaveTextContent(/regression is attributed to cannot be deleted/)
      fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: VALUE } })
      fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

      expect(await within(prompt).findByText(/may take a while/)).toBeInTheDocument()
      act(() => deletion.open())
      await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=commits'))
      expect(deleted).toEqual([`Bearer ${TOKEN}`])
      expect(await screen.findByText('No commits yet.')).toBeInTheDocument()
    })

    it('reports that a commit a regression is attributed to cannot be deleted', async () => {
      signIn('manage')
      server.use(
        mockApi('delete', COMMIT_ROUTE, () =>
          errorResponse(409, 'conflict', `Commit '${VALUE}' is referenced by a regression`),
        ),
      )
      renderCommit()
      await ready('Commit', deleteButton)

      fireEvent.click(deleteButton())
      fireEvent.change(screen.getByRole('textbox'), { target: { value: VALUE } })
      fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

      const prompt = screen.getByRole('form', { name: 'Confirmation' })
      expect(await within(prompt).findByRole('alert')).toHaveTextContent(
        'referenced by a regression',
      )
      expect(currentUrl()).toBe(PAGE)
    })
  })

  describe('its regressions', () => {
    it('are those attributed to the commit, newest first, by UUID and title', async () => {
      const { regressionQueries } = renderCommit({
        regressions: () =>
          HttpResponse.json(
            cursorPage([
              regression('a', { state: 'active', test_count: 3 }),
              regression('b', { title: null }),
            ]),
          ),
      })

      const list = await table('Regressions')
      expect(rowsOf(list)).toEqual([
        'aaaaaaaa… | find_if slowdown | active | 3',
        'bbbbbbbb… | (untitled) | detected | 0',
      ])
      expect(within(list).getByRole('link', { name: 'bbbbbbbb…' })).toHaveAttribute(
        'href',
        `/suites/libcxx/regressions/${uuidOf('b')}`,
      )
      expect(Object.fromEntries(regressionQueries[0])).toEqual({
        commit: VALUE,
        sort: '-created_at',
        limit: '25',
      })
    })

    it('are shown a page at a time', async () => {
      const { regressionQueries } = renderCommit({
        regressions: (query) =>
          HttpResponse.json(
            query.has('cursor')
              ? cursorPage([regression('b')])
              : cursorPage([regression('a')], 'p2'),
          ),
      })
      const list = await table('Regressions')

      fireEvent.click(
        within(screen.getByRole('navigation', { name: 'Regressions pagination' })).getByRole(
          'button',
          { name: 'Next →' },
        ),
      )

      await waitFor(() => expect(rowsOf(list)[0]).toMatch(/^bbbbbbbb…/))
      expect(regressionQueries[1].get('cursor')).toBe('p2')
    })

    it('say when there are none', async () => {
      renderCommit()

      expect(await screen.findByText('No regressions at this commit.')).toBeInTheDocument()
    })

    it('give way to the error when they cannot be fetched, with a retry', async () => {
      let fail = true
      renderCommit({
        regressions: () =>
          fail
            ? errorResponse(500, 'internal_error', 'Regressions unavailable')
            : HttpResponse.json(cursorPage([regression('a')])),
      })

      expect(await screen.findByRole('alert')).toHaveTextContent('Regressions unavailable')
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(rowsOf(await table('Regressions'))).toHaveLength(1)
    })
  })

  describe('its runs', () => {
    it('are sorted by machine, newest first on each, each compared with the commit before', async () => {
      const { lookups, resolved } = renderCommit({ runs: RUNS })

      const runs = await table('Runs')
      expect(rowsOf(runs)).toEqual([
        'linux | bbbbbbbb… | 2026-08-25, 1:00:00 PM | Compare with previous',
        'macos | aaaaaaaa… | 2026-08-25, 2:22:41 PM | Compare with previous',
        'macos | cccccccc… | 2026-08-24, 9:00:00 AM | Compare with previous',
      ])
      expect(screen.getByText('3 runs across 2 machines')).toBeInTheDocument()
      expect(within(runs).getByRole('link', { name: 'linux' })).toHaveAttribute(
        'href',
        '/suites/libcxx/machines/linux',
      )

      // A link once the commit before is known, and no link at all until then.
      await waitFor(() => expect(compareLinks(runs)[0]).toHaveAttribute('href'))
      expect(queryOf(compareLinks(runs)[0])).toEqual({
        suite_a: 'libcxx',
        machine_a: 'linux',
        commit_a: 'before',
        suite_b: 'libcxx',
        machine_b: 'linux',
        commit_b: VALUE,
        runs_b: uuidOf('b'),
        metric: 'execution_time',
      })
      // Once per machine, and the commit's ordinal is known from the page: not resolved again.
      expect(lookups.map((lookup) => lookup.get('machine')).sort()).toEqual(['linux', 'macos'])
      expect(resolved).toEqual([])
    })

    it('are shown as they arrive, with a count of those so far', async () => {
      const second = gate()
      const { runQueries } = renderCommit({
        runPages: async (query) => {
          if (!query.has('cursor')) return HttpResponse.json(cursorPage([RUNS[0]], 'p2'))
          await second.promise
          return HttpResponse.json(cursorPage([RUNS[1]]))
        },
      })

      const runs = await table('Runs')
      expect(await screen.findByText('Loading runs... 1 so far.')).toBeInTheDocument()
      expect(rowsOf(runs)).toHaveLength(1)
      act(() => second.open())

      expect(await screen.findByText('2 runs across 2 machines')).toBeInTheDocument()
      expect(runQueries[1].get('cursor')).toBe('p2')
    })

    it('are filtered by machine name, kept in the URL, and counted', async () => {
      renderCommit({ runs: RUNS })
      const runs = await table('Runs')

      search('Filter machines', ' MAC ')

      await waitFor(() => expect(rowsOf(runs)).toHaveLength(2))
      expect(screen.getByText('2 of 3 runs across 1 of 2 machines')).toBeInTheDocument()
      await waitFor(() => expect(currentUrl()).toBe(`${PAGE}?machine_filter=MAC`))

      search('Filter machines', 'windows')
      expect(await within(runs).findByText('No machines match the filter.')).toBeInTheDocument()
    })

    it('are filtered as the URL says on load', async () => {
      renderCommit({ url: `${PAGE}?machine_filter=linux`, runs: RUNS })

      const runs = await table('Runs')
      expect(screen.getByRole('searchbox', { name: 'Filter machines' })).toHaveValue('linux')
      expect(rowsOf(runs)).toHaveLength(1)
      expect(screen.getByText('1 of 3 runs across 1 of 2 machines')).toBeInTheDocument()
    })

    it('say when there are none', async () => {
      renderCommit()

      expect(await screen.findByText('No runs at this commit.')).toBeInTheDocument()
      expect(screen.getByText('0 runs across 0 machines')).toBeInTheDocument()
    })

    it('give way to the error when the first page fails, with a retry', async () => {
      let fail = true
      renderCommit({
        runPages: () =>
          fail
            ? errorResponse(500, 'internal_error', 'Runs unavailable')
            : HttpResponse.json(cursorPage(RUNS)),
      })

      expect(await main().findByRole('alert')).toHaveTextContent('Runs unavailable')
      expect(screen.queryByRole('table', { name: 'Runs' })).not.toBeInTheDocument()
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(rowsOf(await table('Runs'))).toHaveLength(3)
    })

    it('say they are incomplete when a later page fails, and offer to load the rest', async () => {
      let fail = true
      renderCommit({
        runPages: (query) => {
          if (!query.has('cursor')) return HttpResponse.json(cursorPage([RUNS[0]], 'p2'))
          return fail
            ? errorResponse(500, 'internal_error', 'Runs unavailable')
            : HttpResponse.json(cursorPage([RUNS[1]]))
        },
      })

      expect(await main().findByRole('alert')).toHaveTextContent('Runs unavailable')
      expect(
        screen.getByText('1 run across 1 machine (incomplete: loading the rest failed)'),
      ).toBeInTheDocument()
      fail = false
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

      expect(await screen.findByText('2 runs across 2 machines')).toBeInTheDocument()
    })
  })
})
