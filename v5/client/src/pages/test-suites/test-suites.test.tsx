import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { SUITE, commit, cursorPage, machine, run } from '../../test/fixtures'
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
} from '../../test/page'
import { server } from '../../test/server'

/** The accessible name of the Runs tab's search. */
const RUNS_SEARCH = 'Search runs by machine, commit or UUID'

describe('the Test Suites page', () => {
  it('shows only the suite picker when no suite is selected', async () => {
    mockSuites()
    renderPage('/suites')

    const picker = await screen.findByRole('navigation', { name: 'Test suites' })
    const cards = within(picker).getAllByRole('link')
    expect(cards.map((card) => card.textContent)).toEqual(['libcxx', 'nts'])
    expect(cards[0]).toHaveAttribute('href', '/suites/libcxx')
    expect(cards[0]).not.toHaveAttribute('aria-current')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows the tabs of the selected suite, the Runs tab first', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx')

    const picker = await screen.findByRole('navigation', { name: 'Test suites' })
    expect(within(picker).getByRole('link', { name: 'libcxx' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Runs',
      'Machines',
      'Commits',
      'Regressions',
    ])
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
    expect(await table('Runs')).toBeInTheDocument()
  })

  it('selects another suite by its card, starting again from its Runs tab', async () => {
    mockSuites()
    mockMachines(() => ({ items: [] }))
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?tab=machines&search=linux')

    fireEvent.click(await screen.findByRole('link', { name: 'nts' }))

    await waitFor(() => expect(currentUrl()).toBe('/suites/nts'))
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveValue('')
  })

  it('starts the selected suite afresh when its card is clicked', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?search=linux')
    await table('Runs')

    fireEvent.click(screen.getByRole('link', { name: 'libcxx' }))

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveValue('')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(currentUrl()).toBe('/suites/libcxx')
  })

  it('takes the search up again on going Back to it', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?search=linux')
    await table('Runs')

    // The navbar's link leads to the suite without the search, as a new history entry.
    const navbar = screen.getAllByRole('navigation')[0]
    fireEvent.click(within(navbar).getByRole('link', { name: 'Test Suites' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?search=linux'))
    const input = screen.getByRole('searchbox', { name: RUNS_SEARCH })
    expect(input).toHaveValue('linux')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(currentUrl()).toBe('/suites/libcxx?search=linux')
  })

  it('says that the suite does not exist, alongside the picker', async () => {
    mockSuites()
    renderPage('/suites/nope')

    expect(await screen.findByRole('alert')).toHaveTextContent("Test suite 'nope' not found.")
    expect(screen.getByRole('navigation', { name: 'Test suites' })).toBeInTheDocument()
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('says nothing about the suite until the list has loaded', async () => {
    const list = gate()
    server.use(
      mockApi('get', '/api/suites', async () => {
        await list.promise
        return HttpResponse.json({ items: [SUITE] })
      }),
    )
    renderPage('/suites/nope')

    expect(await screen.findByText('Loading test suites...')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => list.open())
    expect(await screen.findByRole('alert')).toHaveTextContent("Test suite 'nope' not found.")
  })

  it('reports a failure to list the suites, not that the suite does not exist', async () => {
    server.use(
      mockApi('get', '/api/suites', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    renderPage('/suites/libcxx')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByText(/not found/)).not.toBeInTheDocument()
  })

  it('says when there are no suites', async () => {
    mockSuites([])
    renderPage('/suites')

    expect(await screen.findByText('There are no test suites yet.')).toBeInTheDocument()
  })

  it('restores the tab and the search from the URL', async () => {
    mockSuites()
    const queries = mockMachines(() => ({ items: [machine('linux-x86_64')] }))
    renderPage('/suites/libcxx?tab=machines&search=linux')

    expect(await table('Machines')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Machines' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('linux')
    expect(queries[0].get('search')).toBe('linux')
  })

  it('switches tabs without a search', async () => {
    mockSuites()
    mockMachines(() => ({ items: [machine('linux-x86_64')] }))
    const queries = mockCommits(() => cursorPage([]))
    renderPage('/suites/libcxx?tab=machines&search=linux')
    await table('Machines')

    fireEvent.click(screen.getByRole('tab', { name: 'Commits' }))

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=commits'))
    expect(screen.getByRole('searchbox', { name: 'Search commits' })).toHaveValue('')
    await table('Commits')
    expect(queries[0].has('search')).toBe(false)

    mockRuns(() => cursorPage([]))
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx'))
  })

  it('leaves the search alone when the selected tab is clicked again', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?search=linux')
    await table('Runs')

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    expect(currentUrl()).toBe('/suites/libcxx?search=linux')
    const input = screen.getByRole('searchbox', { name: RUNS_SEARCH })
    expect(input).toHaveValue('linux')
  })
})

describe('the Runs tab', () => {
  const TAGGED = commit('abc123', {
    tag: 'v1',
    fields: { svn_revision: 'r100', commit_info: null },
  })
  const PLAIN = commit('def456')

  it('lists the runs newest first, linking to their run, machine and commit', async () => {
    mockSuites()
    const queries = mockRuns(() =>
      cursorPage([
        run('a', { machine: 'linux-x86_64', commit: 'abc123' }),
        run('b', {
          machine: 'macos/arm64?',
          commit: 'def456',
          submitted_at: '2026-08-18T03:57:56Z',
        }),
      ]),
    )
    mockResolve([TAGGED, PLAIN])
    renderPage('/suites/libcxx')

    const runs = await table('Runs')
    await waitFor(() =>
      expect(rowsOf(runs)).toEqual([
        'aaaaaaaa… | linux-x86_64 | r100 (v1) | 2026-08-25, 2:22:41 PM',
        'bbbbbbbb… | macos/arm64? | def456 | 2026-08-18, 3:57:56 AM',
      ]),
    )
    expect(queries[0].getAll('sort')).toEqual(['-submitted_at'])
    expect(queries[0].get('limit')).toBe('25')
    expect(queries[0].has('search')).toBe(false)
    // It searches the machine, the commit or the UUID (TS2), so it says only that.
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveAttribute(
      'placeholder',
      'Search',
    )

    const uuid = run('a').uuid
    expect(within(runs).getByRole('link', { name: 'aaaaaaaa…' })).toHaveAttribute(
      'href',
      `/suites/libcxx/runs/${uuid}`,
    )
    expect(within(runs).getByRole('link', { name: 'aaaaaaaa…' })).toHaveAttribute('title', uuid)
    expect(within(runs).getByRole('link', { name: 'macos/arm64?' })).toHaveAttribute(
      'href',
      '/suites/libcxx/machines/macos%2Farm64%3F',
    )
    expect(within(runs).getByRole('link', { name: 'r100 (v1)' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/abc123',
    )
  })

  it("resolves the page's commits in one request, and shows one it cannot as it is", async () => {
    mockSuites()
    mockRuns(() =>
      cursorPage([
        run('a', { commit: 'abc123' }),
        run('b', { commit: 'abc123' }),
        run('c', { commit: 'deleted' }),
      ]),
    )
    const resolved = mockResolve([TAGGED])
    renderPage('/suites/libcxx')

    const runs = await table('Runs')
    await waitFor(() =>
      expect(within(runs).getAllByRole('link', { name: 'r100 (v1)' })).toHaveLength(2),
    )
    expect(within(runs).getByRole('link', { name: 'deleted' })).toBeInTheDocument()
    expect(resolved).toEqual([['abc123', 'deleted']])
  })

  it('shows the commit strings when their display values cannot be resolved', async () => {
    mockSuites()
    mockRuns(() => cursorPage([run('a', { commit: 'abc123' })]))
    server.use(
      mockApi('post', '/api/suites/{testsuite}/commits/resolve', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    renderPage('/suites/libcxx')

    const runs = await table('Runs')
    expect(within(runs).getByRole('link', { name: 'abc123' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('says there are no more runs on a later page that has none', async () => {
    mockSuites()
    mockRuns((query) =>
      query.get('cursor') === 'page2'
        ? cursorPage([])
        : cursorPage([run('a', { machine: 'first' })], 'page2'),
    )
    mockResolve()
    renderPage('/suites/libcxx')
    await screen.findByRole('link', { name: 'first' })

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))

    expect(await screen.findByText('No more runs.')).toBeInTheDocument()
  })

  it('pages forward and back with Previous and Next', async () => {
    mockSuites()
    const queries = mockRuns((query) =>
      query.get('cursor') === 'page2'
        ? cursorPage([run('b', { machine: 'second' })])
        : cursorPage([run('a', { machine: 'first' })], 'page2'),
    )
    mockResolve()
    renderPage('/suites/libcxx')

    const previous = await screen.findByRole('button', { name: /Previous/ })
    const next = screen.getByRole('button', { name: /Next/ })
    await screen.findByRole('link', { name: 'first' })
    expect(previous).toBeDisabled()

    fireEvent.click(next)
    expect(await screen.findByRole('link', { name: 'second' })).toBeInTheDocument()
    expect(queries[1].get('cursor')).toBe('page2')
    expect(next).toBeDisabled()
    // The position is not kept in the URL (AR2).
    expect(currentUrl()).toBe('/suites/libcxx')

    fireEvent.click(previous)
    expect(await screen.findByRole('link', { name: 'first' })).toBeInTheDocument()
    expect(queries).toHaveLength(2)
  })

  it('shows the error in place of the table when the next page fails, and retries', async () => {
    mockSuites()
    let failures = 1
    const retry = gate()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs', async ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') !== 'page2') {
          return HttpResponse.json(cursorPage([run('a', { machine: 'first' })], 'page2'))
        }
        if (failures-- > 0) return errorResponse(500, 'internal_error', 'The server failed')
        await retry.promise
        return HttpResponse.json(cursorPage([run('b', { machine: 'second' })]))
      }),
    )
    mockResolve()
    renderPage('/suites/libcxx')
    await screen.findByRole('link', { name: 'first' })

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByRole('table', { name: 'Runs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Runs pagination' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    // Loading, rather than the first page again, until the retry answers.
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'first' })).not.toBeInTheDocument()
    act(() => retry.open())
    expect(await screen.findByRole('link', { name: 'second' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the error of a failed search rather than the results of the previous one', async () => {
    mockSuites()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs', ({ request }) =>
        new URL(request.url).searchParams.get('search') === 'linux-x'
          ? errorResponse(500, 'internal_error', 'The server failed')
          : HttpResponse.json(cursorPage([run('a', { machine: 'linux-x86_64' })])),
      ),
    )
    mockResolve()
    renderPage('/suites/libcxx?search=linux')
    await screen.findByRole('link', { name: 'linux-x86_64' })

    search('Search runs by machine, commit or UUID', 'linux-x')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByRole('link', { name: 'linux-x86_64' })).not.toBeInTheDocument()
  })

  it('searches the server once typing pauses, from the first page', async () => {
    mockSuites()
    const queries = mockRuns((query) => {
      const machine = query.get('search') ? `${query.get('search')}-box` : 'any'
      if (query.get('cursor')) return cursorPage([run('b')])
      return cursorPage([run('a', { machine })], 'p2')
    })
    mockResolve()
    renderPage('/suites/libcxx')
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    await waitFor(() => expect(queries).toHaveLength(2))

    search(RUNS_SEARCH, 'l')
    search(RUNS_SEARCH, 'li')
    search(RUNS_SEARCH, 'lin')

    expect(await screen.findByRole('link', { name: 'lin-box' })).toBeInTheDocument()
    expect(queries.slice(2).map((query) => [query.get('search'), query.get('cursor')])).toEqual([
      ['lin', null],
    ])
    expect(currentUrl()).toBe('/suites/libcxx?search=lin')
    expect(screen.getByRole('button', { name: /Previous/ })).toBeDisabled()
  })

  it('never shows the results of a search the user has since changed', async () => {
    mockSuites()
    const slow = gate()
    const queries = mockRuns(async (query) => {
      const text = query.get('search') ?? ''
      if (text === 'lin') await slow.promise
      return cursorPage([run('a', { machine: `${text || 'any'}-box` })])
    })
    mockResolve()
    renderPage('/suites/libcxx')
    await screen.findByRole('link', { name: 'any-box' })

    search(RUNS_SEARCH, 'lin')
    await waitFor(() => expect(queries.map((query) => query.get('search'))).toContain('lin'))
    search(RUNS_SEARCH, 'linux')
    expect(await screen.findByRole('link', { name: 'linux-box' })).toBeInTheDocument()

    act(() => slow.open())
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByRole('link', { name: 'lin-box' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'linux-box' })).toBeInTheDocument()
  })

  it('marks the rows shown as out of date while a search is pending', async () => {
    mockSuites()
    mockRuns(() => cursorPage([run('a')]))
    mockResolve()
    renderPage('/suites/libcxx')
    const runs = await table('Runs')
    expect(runs).toHaveAttribute('aria-busy', 'false')

    search(RUNS_SEARCH, 'linux')

    expect(runs).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?search=linux'))
  })

  it('says when no run matches the search', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/suites/libcxx?search=nothing')

    const message = 'No runs match this search.'
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('reports a failure to list the runs', async () => {
    mockSuites()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    renderPage('/suites/libcxx')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('the Machines tab', () => {
  it('lists machines with the fields they have, labelled, and marks untracked ones', async () => {
    mockSuites()
    const queries = mockMachines(() => ({
      items: [
        machine('linux-x86_64', { fields: { hardware: null, os: 'Linux', core_count: 64 } }),
        machine('macos-O3', {
          tracked: false,
          fields: { hardware: 'Apple M4', os: 'macOS 26.5', core_count: null },
        }),
        machine('bare'),
      ],
    }))
    renderPage('/suites/libcxx?tab=machines')

    const machines = await table('Machines')
    expect(rowsOf(machines)).toEqual([
      'linux-x86_64 | os: Linux, Cores: 64',
      'macos-O3 untracked | Hardware: Apple M4, os: macOS 26.5',
      'bare | ',
    ])
    expect(within(machines).getByRole('link', { name: 'linux-x86_64' })).toHaveAttribute(
      'href',
      '/suites/libcxx/machines/linux-x86_64',
    )
    expect(within(machines).getByText('untracked')).toHaveAttribute(
      'title',
      "Untracked machines are left out of the Dashboard's trend overview, but are listed and " +
        'usable everywhere else.',
    )
    // Every machine, in one request, with no page to ask for or move between (E2).
    expect([...queries[0].keys()]).toEqual([])
    expect(screen.queryByRole('navigation', { name: /pagination/ })).not.toBeInTheDocument()
  })

  it('shows the error of a failed search in place of the table, and retries', async () => {
    mockSuites()
    let failures = 1
    const retry = gate()
    const searches: (string | null)[] = []
    server.use(
      mockApi('get', '/api/suites/{testsuite}/machines', async ({ request }) => {
        const term = new URL(request.url).searchParams.get('search')
        searches.push(term)
        if (term === 'arm' && failures-- > 0) {
          return errorResponse(500, 'internal_error', 'The server failed')
        }
        if (term === 'arm') await retry.promise
        return HttpResponse.json({ items: [machine(term === 'arm' ? 'arm64' : 'x86_64')] })
      }),
    )
    renderPage('/suites/libcxx?tab=machines')
    await screen.findByRole('link', { name: 'x86_64' })

    search('Search machines', 'arm')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByRole('table', { name: 'Machines' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    // Loading, rather than the machines of the previous search again, until the retry answers.
    expect(await screen.findByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'x86_64' })).not.toBeInTheDocument()
    act(() => retry.open())
    expect(await screen.findByRole('link', { name: 'arm64' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(searches).toEqual([null, 'arm', 'arm'])
  })

  it('shares the machine list with the Regressions tab, rather than fetching it again', async () => {
    mockSuites()
    const queries = mockMachines(() => ({ items: [machine('linux-x86_64')] }))
    mockRegressions()
    mockResolve()
    renderPage('/suites/libcxx?tab=machines')
    await screen.findByRole('link', { name: 'linux-x86_64' })

    fireEvent.click(screen.getByRole('tab', { name: 'Regressions' }))

    // The machine combobox is ready at once, from the list the Machines tab fetched.
    const combobox = await screen.findByRole('combobox', { name: 'Machine' })
    await waitFor(() => expect(combobox).toHaveAttribute('placeholder', 'Any machine'))
    expect(queries).toHaveLength(1)
  })

  it('searches the server', async () => {
    mockSuites()
    const queries = mockMachines(() => ({ items: [machine('m0')] }))
    renderPage('/suites/libcxx?tab=machines')
    await table('Machines')

    search('Search machines', 'arm')

    await waitFor(() => expect(currentUrl()).toBe('/suites/libcxx?tab=machines&search=arm'))
    await waitFor(() => expect(queries.at(-1)?.get('search')).toBe('arm'))
  })
})

describe('the Commits tab', () => {
  it('lists the commits most recently seen first, by display value, without the tag', async () => {
    mockSuites()
    const queries = mockCommits(() =>
      cursorPage([
        commit('abc123', {
          ordinal: 591886,
          tag: 'llvm-22.0',
          fields: { svn_revision: 'r591886', commit_info: null },
        }),
        commit('experiment'),
      ]),
    )
    renderPage('/suites/libcxx?tab=commits')

    const commits = await table('Commits')
    expect(rowsOf(commits)).toEqual(['r591886 | 591886 | llvm-22.0', 'experiment | -- | --'])
    expect(within(commits).getByRole('link', { name: 'r591886' })).toHaveAttribute(
      'href',
      '/suites/libcxx/commits/abc123',
    )
    expect(queries[0].get('sort')).toBe('-first_seen')
    expect(queries[0].get('limit')).toBe('25')
  })

  it('pages, and searches from the first page', async () => {
    mockSuites()
    const queries = mockCommits((query) =>
      query.get('cursor') ? cursorPage([commit('older')]) : cursorPage([commit('newer')], 'p2'),
    )
    renderPage('/suites/nts?tab=commits')
    await screen.findByRole('link', { name: 'newer' })

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByRole('link', { name: 'older' })).toBeInTheDocument()

    search('Search commits', 'r59')
    await waitFor(() => expect(queries.at(-1)?.get('search')).toBe('r59'))
    expect(queries.at(-1)?.has('cursor')).toBe(false)
    expect(await screen.findByRole('link', { name: 'newer' })).toBeInTheDocument()
    expect(currentUrl()).toBe('/suites/nts?tab=commits&search=r59')
  })
})
