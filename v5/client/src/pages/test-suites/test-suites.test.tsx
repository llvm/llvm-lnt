import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { HttpResponse } from 'msw'
import { beforeEach, describe, expect, it } from 'vitest'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import type { ProjectName } from '../../api/suites'
import { BARE_SUITE, PROJECT, SUITE, commit, cursorPage, machine, run } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import {
  chipLink,
  chipRow,
  chipTexts,
  commitCard,
  currentUrl,
  gate,
  headersOf,
  mockCommits,
  mockMachines,
  mockRegressions,
  mockResolve,
  mockRuns,
  mockSuites,
  navbarLink,
  projectList,
  renderPage,
  renderPageFrom,
  rowsOf,
  search,
  table,
} from '../../test/page'
import { server } from '../../test/server'

/** Another project, with a display name. */
const SWIFT: ProjectName = { name: 'swift', display_name: 'Swift' }

/** A project without suites, whose name sorts after the others' but its label first. */
const EMPTY: ProjectName = { name: 'zzz', display_name: 'Empty' }

/** The accessible name of the Runs tab's search. */
const RUNS_SEARCH = 'Search runs by machine, commit or UUID'

// The suite's machines, which name a run's machine by its label (AR23): none unless a test says.
beforeEach(() => {
  mockMachines(() => ({ items: [] }))
})

describe('the Projects page', () => {
  it('goes to the first project, without suites, once the projects have loaded', async () => {
    const list = gate()
    mockSuites([SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }], {
      projects: [EMPTY, PROJECT, SWIFT],
      wait: () => list.promise,
    })
    renderPage('/nope')
    fireEvent.click(navbarLink('Projects'))

    expect(await screen.findByText('Loading projects...')).toBeInTheDocument()
    expect(currentUrl()).toBe('/projects')
    act(() => list.open())

    // The first the API lists (AR22), a project without suites included.
    await waitFor(() => expect(currentUrl()).toBe('/projects/zzz'))
    expect(chipLink('Projects', 'Empty')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
  })

  it("goes to the first project's first suite, in place of /projects", async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/nope')
    fireEvent.click(navbarLink('Projects'))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(chipLink('Test suites', 'libcxx')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
  })

  it('goes to the first suite without the query, which it has no use for', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects?tab=machines&search=linux')

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
  })

  it("goes from a project's page to its first suite's, in place of it", async () => {
    mockSuites([SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }], {
      projects: [PROJECT, SWIFT, EMPTY],
    })
    mockRuns(() => cursorPage([]))
    // As the breadcrumb of a detail page, say, leads to it.
    await renderPageFrom('/nope', '/projects/swift?tab=machines')

    // Without the query, which it has no use for.
    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/stdlib'))
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('Projects')
    // In the order the API lists them, rather than by label (AR22).
    expect(chipTexts('Projects')).toEqual(['llvm', 'Swift', 'Empty'])
    expect(chipLink('Projects', 'Swift')).toHaveAttribute('aria-current', 'true')
    expect(chipLink('Test suites', 'stdlib')).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
  })

  it("leads from a project's chip to its first suite, or to its page when it has none", async () => {
    mockSuites([SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }], {
      projects: [PROJECT, SWIFT, EMPTY],
    })
    renderPage('/projects/zzz')

    await waitFor(() => expect(chipTexts('Projects')).toEqual(['llvm', 'Swift', 'Empty']))
    expect(chipLink('Projects', 'Empty')).toHaveAttribute('href', '/projects/zzz')
    expect(chipLink('Projects', 'llvm')).toHaveAttribute('href', '/projects/llvm/suites/libcxx')
    expect(chipLink('Projects', 'Swift')).toHaveAttribute('href', '/projects/swift/suites/stdlib')
  })

  it('says that a project has no suites', async () => {
    mockSuites([SUITE], { projects: [PROJECT, SWIFT] })
    renderPage('/projects/swift')

    expect(await screen.findByText('No test suites.')).toBeInTheDocument()
    expect(screen.queryByRole('navigation', { name: 'Test suites' })).not.toBeInTheDocument()
    expect(chipLink('Projects', 'Swift')).toHaveAttribute('aria-current', 'page')
  })

  it.each([['/projects/nope'], ['/projects/nope/suites/libcxx']])(
    'says that the project does not exist at %s, beside the chips of the projects',
    async (url) => {
      mockSuites()
      renderPage(url)

      expect(await screen.findByRole('alert')).toHaveTextContent("Project 'nope' not found.")
      expect(chipTexts('Projects')).toEqual(['llvm'])
      expect(chipLink('Projects', 'llvm')).not.toHaveAttribute('aria-current')
      expect(screen.queryByRole('navigation', { name: 'Test suites' })).not.toBeInTheDocument()
      expect(currentUrl()).toBe(url)
    },
  )

  it('shows the tabs of the selected suite, the Runs tab first', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx')

    await screen.findByRole('navigation', { name: 'Test suites' })
    expect(chipLink('Test suites', 'libcxx')).toHaveAttribute('aria-current', 'page')
    // The project is the current one of its row, rather than the page shown.
    expect(chipLink('Projects', 'llvm')).toHaveAttribute('aria-current', 'true')
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      'Runs',
      'Machines',
      'Commits',
      'Regressions',
      'Schema',
    ])
    expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true')
    expect(await table('Runs')).toBeInTheDocument()
  })

  it('names the suites by their labels, in the order the API lists them (AR22)', async () => {
    mockSuites([
      { ...SUITE, name: 'zeta', display_name: 'Alpha suite' },
      { ...SUITE, name: 'alpha', display_name: null },
      { ...SUITE, name: 'beta', display_name: 'beta suite' },
    ])
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/alpha')

    await screen.findByRole('navigation', { name: 'Test suites' })
    expect(chipTexts('Test suites')).toEqual(['Alpha suite', 'alpha', 'beta suite'])
    expect(chipLink('Test suites', 'Alpha suite')).toHaveAttribute(
      'href',
      '/projects/llvm/suites/zeta',
    )
  })

  it('picks another suite at the same tab, without its search', async () => {
    mockSuites()
    mockMachines(() => ({ items: [] }))
    renderPage('/projects/llvm/suites/libcxx?tab=machines&search=linux')
    await table('Machines')
    const nts = chipLink('Test suites', 'nts')
    // The selected suite's own chip leads to the tab shown too, in its default state.
    expect(chipLink('Test suites', 'libcxx')).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx?tab=machines',
    )

    fireEvent.click(nts)

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=machines'))
    expect(screen.getByRole('tab', { name: 'Machines' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('')
    // The chip clicked is the same element, rather than one drawn anew, so that it keeps the focus.
    expect(nts).toBeInTheDocument()
  })

  it('picks another project at its first suite, at the same tab, without its search', async () => {
    mockSuites([SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }])
    mockMachines(() => ({ items: [] }))
    renderPage('/projects/llvm/suites/libcxx?tab=machines&search=linux')
    await table('Machines')

    fireEvent.click(chipLink('Projects', 'Swift'))

    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/stdlib?tab=machines'))
    expect(chipTexts('Test suites')).toEqual(['stdlib'])
    expect(chipLink('Test suites', 'stdlib')).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('tab', { name: 'Machines' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('')
  })

  it('picks a chip in place of the page in the history, so that Back leaves the page', async () => {
    mockSuites([SUITE, BARE_SUITE, { ...BARE_SUITE, project: SWIFT, name: 'stdlib' }])
    mockRuns(() => cursorPage([]))
    await renderPageFrom('/nope', '/projects/llvm/suites/libcxx')
    await table('Runs')

    fireEvent.click(chipLink('Test suites', 'nts'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/nts'))
    fireEvent.click(chipLink('Projects', 'Swift'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/swift/suites/stdlib'))

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(currentUrl()).toBe('/nope'))
  })

  it('ignores a click on a selected chip', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx?search=linux')
    await table('Runs')

    // `fireEvent` says whether the click was left to follow the link.
    expect(fireEvent.click(chipLink('Test suites', 'libcxx'))).toBe(false)
    expect(fireEvent.click(chipLink('Projects', 'llvm'))).toBe(false)
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=linux')
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveValue('linux')
  })

  it('leaves a modified click on a selected chip to the browser', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx')
    const libcxx = await screen.findByRole('link', { name: 'libcxx' })

    // What the browser does with the clicks, which jsdom cannot, is kept from happening here.
    const followed: boolean[] = []
    const record = (event: MouseEvent) => {
      followed.push(!event.defaultPrevented)
      event.preventDefault()
    }
    document.addEventListener('click', record)
    try {
      const modifiers = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }]
      for (const init of modifiers) {
        fireEvent.click(libcxx, init)
      }
    } finally {
      document.removeEventListener('click', record)
    }
    expect(followed).toEqual([true, true, true, true])
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx')
  })

  it('takes the search up again on going Back to it', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx?search=linux')
    await table('Runs')

    // The navbar's link leads to the suite without the search, as a new history entry.
    fireEvent.click(navbarLink('Projects'))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
    expect(screen.getByRole('searchbox', { name: RUNS_SEARCH })).toHaveValue('')

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=linux'))
    const input = screen.getByRole('searchbox', { name: RUNS_SEARCH })
    expect(input).toHaveValue('linux')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=linux')
  })

  it('says that the suite does not exist, alongside the chips, selecting no suite', async () => {
    mockSuites()
    renderPage('/projects/llvm/suites/nope?tab=machines')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Test suite 'llvm/nope' not found.",
    )
    expect(chipTexts('Test suites')).toEqual(['libcxx', 'nts'])
    expect(chipRow('Test suites').queryByRole('link', { current: true })).not.toBeInTheDocument()
    // Leading to their default tab, whatever the URL holds.
    expect(chipLink('Test suites', 'nts')).toHaveAttribute('href', '/projects/llvm/suites/nts')
    expect(chipLink('Projects', 'llvm')).toHaveAttribute('aria-current', 'true')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/projects/llvm/suites/nope?tab=machines')
    // It takes the focus only from the tabs it replaces (see the schema editor's tests).
    expect(screen.getByRole('alert')).not.toHaveFocus()
  })

  it('says nothing about the suite until the list has loaded', async () => {
    const list = gate()
    server.use(
      mockApi('get', '/api/projects', async () => {
        await list.promise
        return HttpResponse.json(projectList([SUITE]))
      }),
    )
    renderPage('/projects/llvm/suites/nope')

    expect(await screen.findByText('Loading projects...')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    act(() => list.open())
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Test suite 'llvm/nope' not found.",
    )
  })

  it.each([
    ['/projects', '/projects/llvm/suites/libcxx'],
    ['/projects/llvm', '/projects/llvm/suites/libcxx'],
    ['/projects/llvm/suites/libcxx', '/projects/llvm/suites/libcxx'],
  ])(
    'reports a failure to list the projects at %s, showing nothing more until it is retried',
    async (url, retried) => {
      server.use(
        mockApi('get', '/api/projects', () =>
          errorResponse(500, 'internal_error', 'The server failed'),
        ),
      )
      renderPage(url)

      expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
      expect(screen.queryByText(/not found/)).not.toBeInTheDocument()
      expect(currentUrl()).toBe(url)

      mockSuites()
      mockRuns(() => cursorPage([]))
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
      expect(await screen.findByRole('link', { name: 'libcxx' })).toBeInTheDocument()
      expect(currentUrl()).toBe(retried)
    },
  )

  it('says when there are no projects', async () => {
    mockSuites([], { projects: [] })
    renderPage('/projects')

    expect(await screen.findByText('There are no projects yet.')).toBeInTheDocument()
    expect(currentUrl()).toBe('/projects')
  })

  it('restores the tab and the search from the URL', async () => {
    mockSuites()
    const queries = mockMachines(() => ({ items: [machine('linux-x86_64')] }))
    renderPage('/projects/llvm/suites/libcxx?tab=machines&search=linux')

    expect(await table('Machines')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Machines' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('searchbox', { name: 'Search machines' })).toHaveValue('linux')
    expect(queries[0].get('search')).toBe('linux')
  })

  it('switches tabs without a search', async () => {
    mockSuites()
    mockMachines(() => ({ items: [machine('linux-x86_64')] }))
    const queries = mockCommits(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx?tab=machines&search=linux')
    await table('Machines')

    fireEvent.click(screen.getByRole('tab', { name: 'Commits' }))

    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=commits'))
    expect(screen.getByRole('searchbox', { name: 'Search commits' })).toHaveValue('')
    await table('Commits')
    expect(queries[0].has('search')).toBe(false)

    mockRuns(() => cursorPage([]))
    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx'))
  })

  it('leaves the search alone when the selected tab is clicked again', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx?search=linux')
    await table('Runs')

    fireEvent.click(screen.getByRole('tab', { name: 'Runs' }))

    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=linux')
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

  it("names a run's machine by its label, linking to it by name (AR23)", async () => {
    mockSuites()
    mockRuns(() => cursorPage([run('a', { machine: 'linux-x86_64', commit: 'abc123' })]))
    mockResolve([TAGGED])
    mockMachines(() => ({ items: [machine('linux-x86_64', { display_name: 'Linux / x86-64' })] }))
    renderPage('/projects/llvm/suites/libcxx')

    const runs = await table('Runs')
    expect(await within(runs).findByRole('link', { name: 'Linux / x86-64' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/machines/linux-x86_64',
    )
  })

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
    renderPage('/projects/llvm/suites/libcxx')

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
      `/projects/llvm/suites/libcxx/runs/${uuid}`,
    )
    expect(within(runs).getByRole('link', { name: 'aaaaaaaa…' })).toHaveAttribute('title', uuid)
    expect(within(runs).getByRole('link', { name: 'macos/arm64?' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/machines/macos%2Farm64%3F',
    )
    expect(within(runs).getByRole('link', { name: 'r100 (v1)' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/commits/abc123',
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
    renderPage('/projects/llvm/suites/libcxx')

    const runs = await table('Runs')
    await waitFor(() =>
      expect(within(runs).getAllByRole('link', { name: 'r100 (v1)' })).toHaveLength(2),
    )
    expect(within(runs).getByRole('link', { name: 'deleted' })).toBeInTheDocument()
    expect(resolved).toEqual([['abc123', 'deleted']])
  })

  it("shows a commit's card, as resolved for the page, without asking for it again", async () => {
    mockSuites()
    mockRuns(() => cursorPage([run('a', { commit: 'abc123' })]))
    const resolved = mockResolve([TAGGED])
    renderPage('/projects/llvm/suites/libcxx')

    const runs = await table('Runs')
    const card = await commitCard(await within(runs).findByRole('link', { name: 'r100 (v1)' }))
    expect(card).toHaveAccessibleName('r100 (v1)')
    expect(card).toHaveTextContent('abc123')
    expect(resolved).toEqual([['abc123']])
  })

  it('shows the commit strings when their display values cannot be resolved', async () => {
    mockSuites()
    mockRuns(() => cursorPage([run('a', { commit: 'abc123' })]))
    server.use(
      mockApi('post', '/api/projects/{project}/suites/{suite}/commits/resolve', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    renderPage('/projects/llvm/suites/libcxx')

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
    renderPage('/projects/llvm/suites/libcxx')
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
    renderPage('/projects/llvm/suites/libcxx')

    const previous = await screen.findByRole('button', { name: /Previous/ })
    const next = screen.getByRole('button', { name: /Next/ })
    await screen.findByRole('link', { name: 'first' })
    expect(previous).toBeDisabled()

    fireEvent.click(next)
    expect(await screen.findByRole('link', { name: 'second' })).toBeInTheDocument()
    expect(queries[1].get('cursor')).toBe('page2')
    expect(next).toBeDisabled()
    // The position is not kept in the URL (AR7).
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx')

    fireEvent.click(previous)
    expect(await screen.findByRole('link', { name: 'first' })).toBeInTheDocument()
    expect(queries).toHaveLength(2)
  })

  it('shows the error in place of the table when the next page fails, and retries', async () => {
    mockSuites()
    let failures = 1
    const retry = gate()
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/runs', async ({ request }) => {
        if (new URL(request.url).searchParams.get('cursor') !== 'page2') {
          return HttpResponse.json(cursorPage([run('a', { machine: 'first' })], 'page2'))
        }
        if (failures-- > 0) return errorResponse(500, 'internal_error', 'The server failed')
        await retry.promise
        return HttpResponse.json(cursorPage([run('b', { machine: 'second' })]))
      }),
    )
    mockResolve()
    renderPage('/projects/llvm/suites/libcxx')
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
      mockApi('get', '/api/projects/{project}/suites/{suite}/runs', ({ request }) =>
        new URL(request.url).searchParams.get('search') === 'linux-x'
          ? errorResponse(500, 'internal_error', 'The server failed')
          : HttpResponse.json(cursorPage([run('a', { machine: 'linux-x86_64' })])),
      ),
    )
    mockResolve()
    renderPage('/projects/llvm/suites/libcxx?search=linux')
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
    renderPage('/projects/llvm/suites/libcxx')
    fireEvent.click(await screen.findByRole('button', { name: /Next/ }))
    await waitFor(() => expect(queries).toHaveLength(2))

    search(RUNS_SEARCH, 'l')
    search(RUNS_SEARCH, 'li')
    search(RUNS_SEARCH, 'lin')

    expect(await screen.findByRole('link', { name: 'lin-box' })).toBeInTheDocument()
    expect(queries.slice(2).map((query) => [query.get('search'), query.get('cursor')])).toEqual([
      ['lin', null],
    ])
    expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=lin')
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
    renderPage('/projects/llvm/suites/libcxx')
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
    renderPage('/projects/llvm/suites/libcxx')
    const runs = await table('Runs')
    expect(runs).toHaveAttribute('aria-busy', 'false')

    search(RUNS_SEARCH, 'linux')

    expect(runs).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?search=linux'))
  })

  it('says when no run matches the search', async () => {
    mockSuites()
    mockRuns(() => cursorPage([]))
    renderPage('/projects/llvm/suites/libcxx?search=nothing')

    const message = 'No runs match this search.'
    expect(await screen.findByText(message)).toBeInTheDocument()
  })

  it('reports a failure to list the runs', async () => {
    mockSuites()
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/runs', () =>
        errorResponse(500, 'internal_error', 'The server failed'),
      ),
    )
    renderPage('/projects/llvm/suites/libcxx')

    expect(await screen.findByRole('alert')).toHaveTextContent('The server failed')
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })
})

describe('the Machines tab', () => {
  it('lists machines with their listed fields, labelled, and marks untracked ones', async () => {
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
    renderPage('/projects/llvm/suites/libcxx?tab=machines')

    const machines = await table('Machines')
    // `os` is not listed, so it is left out, whatever its values.
    expect(headersOf(machines)).toEqual(['Machine', 'Hardware', 'Cores'])
    // By label (AR23), whatever the order the API lists them in.
    expect(rowsOf(machines)).toEqual([
      'bare | -- | --',
      'linux-x86_64 | -- | 64',
      'macos-O3 untracked | Apple M4 | --',
    ])
    expect(within(machines).getByRole('link', { name: 'linux-x86_64' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/machines/linux-x86_64',
    )
    expect(within(machines).getByText('untracked')).toHaveAttribute(
      'title',
      "Untracked machines are left out of the Dashboard's trend overview, and listed after the " +
        'tracked ones wherever a machine is picked, but are usable everywhere.',
    )
    // Every machine, in one request, with no page to ask for or move between (E2).
    expect([...queries[0].keys()]).toEqual([])
    expect(screen.queryByRole('navigation', { name: /pagination/ })).not.toBeInTheDocument()
  })

  it('names a machine by its label, followed by its name, and sorts by label (AR23)', async () => {
    mockSuites()
    mockMachines(() => ({
      items: [
        machine('a-linux', { display_name: 'Zeta / Linux' }),
        machine('b-macos'),
        machine('c-arm', { display_name: 'Arm / Graviton', tracked: false }),
      ],
    }))
    renderPage('/projects/llvm/suites/libcxx?tab=machines')

    const machines = await table('Machines')
    expect(rowsOf(machines)).toEqual([
      'Arm / Graviton c-arm untracked | -- | --',
      'b-macos | -- | --',
      'Zeta / Linux a-linux | -- | --',
    ])
    // The link is named by the label, and leads to the machine by its name.
    expect(within(machines).getByRole('link', { name: 'Zeta / Linux' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/machines/a-linux',
    )
  })

  it('links a listed value that is a URL, cut short, to the whole URL', async () => {
    mockSuites()
    const url = 'https://example.com/hardware/amd-epyc-9654-96-core-processor'
    mockMachines(() => ({
      items: [machine('linux-x86_64', { fields: { hardware: url, os: null, core_count: 64 } })],
    }))
    renderPage('/projects/llvm/suites/libcxx?tab=machines')

    const machines = await table('Machines')
    // Assistive technology reads the whole URL as the link's name.
    const link = within(machines).getByRole('link', { name: url })
    expect(link).toHaveAttribute('href', url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(within(link).getByTitle(url)).toHaveTextContent(
      /^https:\/\/example\.com\/hardware\/amd-epyc-9654-96-cor…$/,
    )
  })

  it('shows the error of a failed search in place of the table, and retries', async () => {
    mockSuites()
    let failures = 1
    const retry = gate()
    const searches: (string | null)[] = []
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/machines', async ({ request }) => {
        const term = new URL(request.url).searchParams.get('search')
        searches.push(term)
        if (term === 'arm' && failures-- > 0) {
          return errorResponse(500, 'internal_error', 'The server failed')
        }
        if (term === 'arm') await retry.promise
        return HttpResponse.json({ items: [machine(term === 'arm' ? 'arm64' : 'x86_64')] })
      }),
    )
    renderPage('/projects/llvm/suites/libcxx?tab=machines')
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
    renderPage('/projects/llvm/suites/libcxx?tab=machines')
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
    renderPage('/projects/llvm/suites/libcxx?tab=machines')
    await table('Machines')

    search('Search machines', 'arm')

    await waitFor(() =>
      expect(currentUrl()).toBe('/projects/llvm/suites/libcxx?tab=machines&search=arm'),
    )
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
          fields: { svn_revision: 'r591886', commit_info: '[libc++] Speed up std::format' },
        }),
        commit('experiment', {
          fields: {
            svn_revision: null,
            commit_info: 'A/B experiment: a faster floating-point path for std::format',
          },
        }),
        commit('bare'),
      ]),
    )
    renderPage('/projects/llvm/suites/libcxx?tab=commits')

    const commits = await table('Commits')
    // The fields the schema lists follow, cut short when long, and whole on hover.
    expect(headersOf(commits)).toEqual(['Commit', 'Ordinal', 'Tag', 'commit_info'])
    const [first, experiment, bare] = rowsOf(commits)
    expect(first).toBe('r591886 | 591886 | llvm-22.0 | [libc++] Speed up std::format')
    expect(bare).toBe('bare | -- | -- | --')
    // Assistive technology reads the whole value rather than the cut one.
    const info = 'A/B experiment: a faster floating-point path for std::format'
    expect(experiment).toMatch(/^experiment \| -- \| -- \| /)
    const cut = within(commits).getByTitle(info)
    expect(cut).toHaveTextContent(/^A\/B experiment: a faster floating-point path for …$/)
    expect(cut).toHaveAttribute('aria-hidden', 'true')
    expect(within(commits).getByText(info)).toBeInTheDocument()
    expect(within(commits).getByRole('link', { name: 'r591886' })).toHaveAttribute(
      'href',
      '/projects/llvm/suites/libcxx/commits/abc123',
    )
    expect(queries[0].get('sort')).toBe('-first_seen')
    expect(queries[0].get('limit')).toBe('25')
  })

  it("shows a commit's card, with its tag, as listed, without asking for it", async () => {
    mockSuites()
    mockCommits(() =>
      cursorPage([
        commit('abc123', {
          ordinal: 591886,
          tag: 'llvm-22.0',
          fields: { svn_revision: 'r591886', commit_info: null },
        }),
      ]),
    )
    renderPage('/projects/llvm/suites/libcxx?tab=commits')

    const commits = await table('Commits')
    const card = await commitCard(within(commits).getByRole('link', { name: 'r591886' }))
    expect(card).toHaveAccessibleName('r591886 (llvm-22.0)')
    expect(within(card).getByText('591886')).toBeInTheDocument()
  })

  it('links a listed value that is a URL, but not a display value, which names the commit', async () => {
    // The display field is listed too: its column shows it as a field's value.
    mockSuites([
      { ...SUITE, commit_fields: SUITE.commit_fields.map((field) => ({ ...field, listed: true })) },
    ])
    const display = 'https://example.com/r591886'
    const info = 'https://example.com/r591886/message'
    mockCommits(() =>
      cursorPage([commit('abc123', { fields: { svn_revision: display, commit_info: info } })]),
    )
    renderPage('/projects/llvm/suites/libcxx?tab=commits')

    const commits = await table('Commits')
    const displayLinks = within(commits).getAllByRole('link', { name: display })
    expect(displayLinks.map((link) => link.getAttribute('href'))).toEqual([
      '/projects/llvm/suites/libcxx/commits/abc123',
      display,
    ])
    expect(within(commits).getByRole('link', { name: info })).toHaveAttribute('href', info)
  })

  it('pages, and searches from the first page', async () => {
    mockSuites()
    const queries = mockCommits((query) =>
      query.get('cursor') ? cursorPage([commit('older')]) : cursorPage([commit('newer')], 'p2'),
    )
    renderPage('/projects/llvm/suites/nts?tab=commits')
    await screen.findByRole('link', { name: 'newer' })

    fireEvent.click(screen.getByRole('button', { name: /Next/ }))
    expect(await screen.findByRole('link', { name: 'older' })).toBeInTheDocument()

    search('Search commits', 'r59')
    await waitFor(() => expect(queries.at(-1)?.get('search')).toBe('r59'))
    expect(queries.at(-1)?.has('cursor')).toBe(false)
    expect(await screen.findByRole('link', { name: 'newer' })).toBeInTheDocument()
    expect(currentUrl()).toBe('/projects/llvm/suites/nts?tab=commits&search=r59')
  })
})
