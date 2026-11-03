import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import type { Schemas } from '../../api/client'
import { withoutNeighbours } from '../../api/commits'
import { INACTIVITY_HELP } from '../../inactivity'
import type { SuiteSchema } from '../../api/suites'
import { signIn, TOKEN } from '../../test/auth'
import {
  commit,
  cursorPage,
  NO_REPOSITORY,
  regression,
  run,
  SUITE,
  uuidOf,
} from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  currentUrl,
  editButton,
  expectInfoRow,
  gate,
  inactivityCell,
  infoRows,
  main,
  mockCommits,
  mockResolve,
  mockSent,
  mockSuites,
  queryOf,
  ready,
  recording,
  renderPage,
  rowsOf,
  save,
  search,
  table,
  trailLink,
  type Respond,
} from '../../test/page'
import { server } from '../../test/server'

const VALUE = 'abc123'
const PAGE = `/projects/llvm/suites/libcxx/commits/${VALUE}`
const COMMIT_ROUTE = '/api/projects/{project}/suites/{suite}/commits/{value}'

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
  /** The suites the API lists: `SUITE` and `BARE_SUITE` by default. */
  suites?: SuiteSchema[]
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
  suites,
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
  mockSuites(suites)
  const resolved = mockResolve([withoutNeighbours(DETAIL)])
  server.use(
    mockApi('get', COMMIT_ROUTE, () => {
      detailCalls.count++
      return detail()
    }),
    mockApi('get', '/api/projects/{project}/suites/{suite}/runs', ({ request }) =>
      runList.answer(request),
    ),
    mockApi('get', '/api/projects/{project}/suites/{suite}/regressions', ({ request }) =>
      regressionList.answer(request),
    ),
    mockApi('get', '/api/projects/{project}/suites/{suite}/commits', ({ request }) =>
      lookups.answer(request),
    ),
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

/** The commit `DETAIL` becomes once `body` is applied, as the API answers a PATCH. */
function patched(body: Schemas['CommitUpdate']): Schemas['CommitDetail'] {
  return { ...DETAIL, ...body }
}

const deleteButton = () => screen.getByRole('button', { name: 'Delete commit' })

/** The page's link named `name`. */
function link(name: string) {
  return main().getByRole('link', { name })
}

/** The Compare with previous link of each row of the table `runs`. */
function compareLinks(runs: HTMLElement) {
  return within(runs).getAllByRole('link', { name: 'Compare with previous' })
}

/** Wait until the row `row` of the info box shows `expected`, as its label and value. */
const expectInfo = (row: number, expected: [string, string]) =>
  expectInfoRow('Commit', row, expected)

/** Runs on two machines, macos twice, in the order the API gives them: most recently measured first. */
const RUNS = [
  run('a', { machine: 'macos', measured_at: '2026-08-25T14:22:41Z' }),
  run('b', { machine: 'linux', measured_at: '2026-08-25T13:00:00Z' }),
  run('c', { machine: 'macos', measured_at: '2026-08-24T09:00:00Z' }),
]

describe('the Commit Detail page', () => {
  it('shows the commit string, its ordinal, its tag and its fields, labelled', async () => {
    renderCommit()

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(`Commit: ${VALUE}`)
    expect(await infoRows('Commit')).toEqual([
      ['Commit', VALUE],
      ['Ordinal', '100Edit'],
      ['Tag', 'v1Edit'],
      ['Delete after inactivity', inactivityCell('--')],
      ['svn_revision display', 'r100Edit'],
      ['commit_info', 'Fix the vectorizerEdit'],
    ])
    // An identifier, set as a table sets one.
    expect(within(screen.getByRole('group', { name: 'Commit' })).getByText(VALUE)).toHaveClass(
      'mono',
    )
  })

  it('marks the display field, saying what it is on hover', async () => {
    renderCommit()

    const box = await screen.findByRole('group', { name: 'Commit' })
    const badges = within(box).getAllByText('display')
    expect(badges).toHaveLength(1)
    expect(badges[0].closest('dt')).toHaveTextContent(/^svn_revision/)
    expect(badges[0]).toHaveAttribute(
      'title',
      'The UI shows a commit by the value of this field, when it has one, rather than by its ' +
        'commit string.',
    )
  })

  it('marks the display field even when the commit has no value for it', async () => {
    renderCommit({
      detail: () =>
        HttpResponse.json({ ...DETAIL, fields: { ...DETAIL.fields, svn_revision: null } }),
    })

    expect((await infoRows('Commit'))[4]).toEqual(['svn_revision display', '--Edit'])
  })

  it('shows a field value that is a URL as a link, even the display field', async () => {
    const url = 'https://example.com/r100'
    renderCommit({
      detail: () =>
        HttpResponse.json({ ...DETAIL, fields: { ...DETAIL.fields, svn_revision: url } }),
    })

    expect((await infoRows('Commit'))[4]).toEqual(['svn_revision display', `${url}Edit`])
    const box = screen.getByRole('group', { name: 'Commit' })
    expect(within(box).getByRole('link', { name: url })).toHaveAttribute('href', url)
  })

  it('marks no field when the schema has none to display', async () => {
    const fields = SUITE.commit_fields.map((field) => ({ ...field, display: false }))
    renderCommit({ suites: [{ ...SUITE, commit_fields: fields }] })

    expect((await infoRows('Commit')).slice(4)).toEqual([
      ['svn_revision', 'r100Edit'],
      ['commit_info', 'Fix the vectorizerEdit'],
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

  it('shows only the error for a commit that does not exist, with no retry, and the trail', async () => {
    renderCommit({
      detail: () => errorResponse(404, 'not_found', `Commit '${VALUE}' not found in test suite`),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('not found')
    expect(screen.queryByRole('heading', { name: 'Runs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Regressions' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(trailLink('Commits')).toHaveAttribute('href', '/projects/llvm/suites/libcxx?tab=commits')
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
      sort: '-measured_at',
      limit: '10000',
    })
    act(() => answer.open())
    expect(await table('Runs')).toBeInTheDocument()
  })

  describe('its neighbours', () => {
    it('are linked, and named on hover by their display values', async () => {
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      expect(link('← Previous commit')).toHaveAttribute(
        'href',
        '/projects/llvm/suites/libcxx/commits/prev99',
      )
      expect(link('← Previous commit')).toHaveAttribute('title', 'r99')
      expect(link('Next commit →')).toHaveAttribute(
        'href',
        '/projects/llvm/suites/libcxx/commits/next101',
      )
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

      await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx/commits/prev99'))
      expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Commit: prev99')
      await expectInfo(0, ['Commit', 'prev99'])
      expect(screen.queryByRole('textbox', { name: 'Tag' })).not.toBeInTheDocument()
    })
  })

  describe('its link into the repository', () => {
    it('leads to the commit in a new tab, among the navigation buttons', async () => {
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      const viewOn = link('View on GitHub')
      expect(viewOn).toHaveAttribute('href', `https://github.com/llvm/llvm-project/commit/${VALUE}`)
      expect(viewOn).toHaveAttribute('target', '_blank')
      expect(viewOn).toHaveAttribute('rel', 'noopener noreferrer')
      // Looking like the buttons beside it, rather than beside the commit string. A comparison
      // with the previous commit is left to the Graph and Compare pages.
      expect(viewOn).toHaveClass('button')
      expect(main().getAllByRole('link', { name: /^View/ })).toEqual([viewOn])
    })

    it('leads to a commit with no ordinal too', async () => {
      renderCommit({
        detail: () => HttpResponse.json({ ...DETAIL, ordinal: null, previous: null, next: null }),
      })

      await screen.findByRole('group', { name: 'Commit' })
      expect(link('View on GitHub')).toHaveAttribute(
        'href',
        `https://github.com/llvm/llvm-project/commit/${VALUE}`,
      )
    })

    it('is not shown when the suite has no template of its URL', async () => {
      renderCommit({ suites: [{ ...SUITE, repository: NO_REPOSITORY }] })

      await screen.findByRole('group', { name: 'Commit' })
      expect(main().queryByRole('link', { name: /^View/ })).not.toBeInTheDocument()
    })
  })

  describe('its ordinal and tag', () => {
    it('cannot be edited without manage scope', async () => {
      signIn('triage')
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      for (const field of ['Ordinal', 'Tag', 'Delete after inactivity']) {
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
      const sent = mockSent('patch', COMMIT_ROUTE, async (body) => {
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
      expect(link('← Previous commit')).toHaveAttribute(
        'href',
        '/projects/llvm/suites/libcxx/commits/before',
      )
      expect(link('Next commit →')).not.toHaveAttribute('href')
    })

    it('do not accept an ordinal that is not an integer its column can hold', async () => {
      signIn('manage')
      const sent = mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
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
      const sent = mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
      renderCommit()
      await ready('Commit', () => editButton('Tag'))

      save('Tag', '  ')

      await expectInfo(2, ['Tag', '--Edit'])
      expect(sent.map(({ body }) => body)).toEqual([{ tag: null }])
    })

    it('report a change the API refuses, keeping the editor open with its text', async () => {
      signIn('manage')
      mockSent('patch', COMMIT_ROUTE, () =>
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
      mockSent('patch', COMMIT_ROUTE, async (body) => {
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
      mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
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
      mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
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
      mockSent('patch', COMMIT_ROUTE, (body) =>
        HttpResponse.json({ ...patched(body), previous: null, next: null }),
      )
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
      mockSent('patch', COMMIT_ROUTE, (body) => {
        stored = { ...stored, ...body }
        return HttpResponse.json(patched(body))
      })
      renderCommit({ url: '/projects/llvm/suites/libcxx?tab=commits' })
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

  describe('its fields', () => {
    it('cannot be edited without manage scope', async () => {
      signIn('triage')
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      for (const field of ['svn_revision', 'commit_info']) {
        await waitFor(() =>
          expect(editButton(field)).toHaveAttribute(
            'title',
            expect.stringMatching(/has the 'triage' scope/),
          ),
        )
        expect(editButton(field)).toBeDisabled()
      }
    })

    it('are changed with PATCH one at a time, and cleared when emptied', async () => {
      signIn('manage')
      let stored = DETAIL
      const sent = mockSent('patch', COMMIT_ROUTE, (body) => {
        stored = { ...stored, fields: { ...stored.fields, ...body.fields } }
        return HttpResponse.json(stored)
      })
      renderCommit()
      await ready('Commit', () => editButton('commit_info'))

      save('commit_info', ' Fix the vectorizer\n\nIt was slow. ')
      await expectInfo(5, ['commit_info', 'Fix the vectorizer\n\nIt was slow.Edit'])
      save('svn_revision', '')
      await expectInfo(4, ['svn_revision display', '--Edit'])

      expect(sent).toEqual([
        {
          body: { fields: { commit_info: 'Fix the vectorizer\n\nIt was slow.' } },
          auth: `Bearer ${TOKEN}`,
        },
        { body: { fields: { svn_revision: null } }, auth: `Bearer ${TOKEN}` },
      ])
      // The page shows the commit string, whatever the display field holds.
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Commit: ${VALUE}`)
    })

    it('show a new display value in the commit list, once fetched again', async () => {
      signIn('manage')
      let stored: Schemas['Commit'] = withoutNeighbours(DETAIL)
      mockSent('patch', COMMIT_ROUTE, (body) => {
        stored = { ...stored, fields: { ...stored.fields, ...body.fields } }
        return HttpResponse.json({ ...DETAIL, ...stored })
      })
      renderCommit({ url: '/projects/llvm/suites/libcxx?tab=commits' })
      const listQueries = mockCommits(() => cursorPage([stored]))
      server.use(mockApi('get', COMMIT_ROUTE, () => HttpResponse.json(DETAIL)))
      fireEvent.click(within(await table('Commits')).getByRole('link', { name: 'r100' }))
      await ready('Commit', () => editButton('svn_revision'))

      save('svn_revision', 'r200')
      await expectInfo(4, ['svn_revision display', 'r200Edit'])
      fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

      const commits = await table('Commits')
      expect(await within(commits).findByRole('link', { name: 'r200' })).toBeInTheDocument()
      expect(listQueries).toHaveLength(2)
    })
  })

  describe('its deletion after inactivity', () => {
    const row = async () => (await infoRows('Commit'))[3]

    it('shows the days, and that they have no effect while the commit has an ordinal', async () => {
      renderCommit({
        detail: () => HttpResponse.json({ ...DETAIL, delete_after_inactive_days: 30 }),
      })

      expect(await row()).toEqual([
        'Delete after inactivity',
        inactivityCell('30 days (No effect while the commit has an ordinal.)'),
      ])
    })

    it('shows the days alone for a commit without an ordinal', async () => {
      renderCommit({
        detail: () =>
          HttpResponse.json({
            ...DETAIL,
            ordinal: null,
            previous: null,
            next: null,
            delete_after_inactive_days: 1,
          }),
      })

      expect(await row()).toEqual(['Delete after inactivity', inactivityCell('1 day')])
    })

    it('explains itself, on hover and to assistive technology', async () => {
      signIn('manage')
      renderCommit()

      await ready('Commit', () => editButton('Delete after inactivity'))
      expect(screen.getByText('Delete after inactivity')).toHaveAttribute('title', INACTIVITY_HELP)
      expect(editButton('Delete after inactivity')).toHaveAccessibleDescription(INACTIVITY_HELP)
    })

    it('says why it cannot be edited as well, to assistive technology', async () => {
      signIn('triage')
      renderCommit()

      await screen.findByRole('group', { name: 'Commit' })
      await waitFor(() =>
        expect(editButton('Delete after inactivity').title).toMatch(/'triage' scope/),
      )
      await waitFor(() =>
        expect(editButton('Delete after inactivity')).toHaveAccessibleDescription(
          `${INACTIVITY_HELP} ${editButton('Delete after inactivity').title}`,
        ),
      )
    })

    it('is changed with PATCH, and cleared when emptied', async () => {
      signIn('manage')
      const sent = mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
      renderCommit()
      await ready('Commit', () => editButton('Delete after inactivity'))

      save('Delete after inactivity', ' 30 ')
      await expectInfo(3, [
        'Delete after inactivity',
        inactivityCell('30 days (No effect while the commit has an ordinal.)'),
      ])
      save('Delete after inactivity', '')
      await expectInfo(3, ['Delete after inactivity', inactivityCell('--')])

      expect(sent.map(({ body }) => body)).toEqual([
        { delete_after_inactive_days: 30 },
        { delete_after_inactive_days: null },
      ])
    })

    it('does not accept anything but a whole number of days from 1 to 36500', async () => {
      signIn('manage')
      const sent = mockSent('patch', COMMIT_ROUTE, (body) => HttpResponse.json(patched(body)))
      renderCommit()
      await ready('Commit', () => editButton('Delete after inactivity'))
      save('Delete after inactivity', '0')
      const input = screen.getByRole('textbox', { name: 'Delete after inactivity' })
      const why = 'A number of days is a whole number from 1 to 36500.'

      for (const text of ['0', '36501', '1.5', '-1', '1e3', 'week']) {
        fireEvent.change(input, { target: { value: text } })
        fireEvent.submit(input)
        expect(input).toHaveAccessibleDescription(expect.stringContaining(why))
      }
      expect(sent).toEqual([])

      fireEvent.change(input, { target: { value: '36500' } })
      expect(input).not.toHaveAccessibleDescription(expect.stringContaining(why))
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
      expect(prompt).toHaveTextContent(/Regressions attributed to it are kept, without a commit/)
      fireEvent.change(within(prompt).getByRole('textbox'), { target: { value: VALUE } })
      fireEvent.click(within(prompt).getByRole('button', { name: 'Delete' }))

      expect(await within(prompt).findByText(/may take a while/)).toBeInTheDocument()
      act(() => deletion.open())
      await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=commits'))
      expect(deleted).toEqual([`Bearer ${TOKEN}`])
      expect(await screen.findByText('No commits yet.')).toBeInTheDocument()
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
        `/projects/llvm/suites/libcxx/regressions/${uuidOf('b')}`,
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
    it('are sorted by machine, most recently measured first on each, each compared with the commit before', async () => {
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
        '/projects/llvm/suites/libcxx/machines/linux',
      )

      // A link once the commit before is known, and no link at all until then.
      await waitFor(() => expect(compareLinks(runs)[0]).toHaveAttribute('href'))
      expect(queryOf(compareLinks(runs)[0])).toEqual({
        project_a: 'llvm',
        suite_a: 'libcxx',
        machine_a: 'linux',
        commit_a: 'before',
        project_b: 'llvm',
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
