import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import {
  commitCard,
  currentUrl,
  gate,
  main,
  mockResolve,
  mockSuites,
  query,
  renderPage,
  settle,
} from '../../test/page'
import { pick, pickSuite, selectButton } from '../../test/select'
import { inProject, NO_REPOSITORY, SUITE, uuidOf } from '../../test/fixtures'
import { COMPARED, comparison, mockWorld, ROWS, runBox, sideOf, SUITES } from './compare-world'

// The page renders its chart, which Plotly cannot draw in jsdom (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

describe('the Compare page (CP1)', () => {
  it('says what it needs before it can compare, a step at a time', async () => {
    mockWorld()
    renderPage('/compare')

    expect(await main().findByText('Select a suite for side A.')).toBeInTheDocument()
    expect(selectButton('Metric')).toHaveTextContent('-- Select metric --')
    expect(selectButton('Metric')).toBeDisabled()
    await pickSuite('Suite', 'llvm', 'libcxx', sideOf('A'))
    expect(await main().findByText('Select a machine for side A.')).toBeInTheDocument()
    expect(selectButton('Metric')).toBeEnabled()
    await pick('Machine', 'm1', sideOf('A'))
    expect(await main().findByText('Select a commit for side A.')).toBeInTheDocument()
    await pick('Commit', 'c1', sideOf('A'))
    expect(await main().findByText('Select a suite for side B.')).toBeInTheDocument()
    expect(runBox('1', 'A')).toBeChecked()
    expect(runBox('2', 'A')).toBeChecked()
  })

  it('compares the runs of the commits the URL names (CP2)', async () => {
    mockWorld()
    renderPage(COMPARED)

    expect(await comparison()).toEqual(ROWS)
    expect(screen.getByText('3 of 3 tests shown')).toBeInTheDocument()
  })

  it('lists a side’s runs in the order they were measured, with when each was measured', async () => {
    const sorts: (string | null)[] = []
    mockWorld({
      runsAnswer: (query) => {
        sorts.push(query.get('sort'))
        return undefined
      },
    })
    renderPage(COMPARED)
    await comparison()

    expect(new Set(sorts)).toEqual(new Set(['measured_at']))
    // The world's runs are measured a day apart, in the order it lists them (see `mockWorld`).
    expect(within(sideOf('A')).getByText('2026-08-20, 10:00:00 AM')).toBeInTheDocument()
    expect(within(sideOf('A')).getByText('2026-08-21, 10:00:00 AM')).toBeInTheDocument()
  })

  it('selects every run of a side by default, and keeps a subset in the URL', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    await userEvent.setup().click(runBox('2', 'A'))

    // Side A's value of a is now run 1's alone.
    await waitFor(async () =>
      expect((await comparison())[1]).toBe('a | 1 | 4 | 3 | +300.00% | 4.0000 | Regressed'),
    )
    expect(query().runs_a).toEqual([uuidOf('1')])
  })

  it('restores the runs the URL names, and every run when it names none of them', async () => {
    mockWorld()
    renderPage(`${COMPARED}&runs_a=${uuidOf('2')}&runs_b=${uuidOf('9')}`)

    expect((await comparison())[1]).toBe('a | 3 | 4 | 1 | +33.33% | 1.3333 | Regressed')
    expect(runBox('1', 'A')).not.toBeChecked()
    expect(runBox('3', 'B')).toBeChecked()
    await waitFor(() => expect(query().runs_b).toBeUndefined())
    expect(query().runs_a).toEqual([uuidOf('2')])
  })

  it('selects every run again when a commit is picked again', async () => {
    mockWorld()
    renderPage(`${COMPARED}&runs_a=${uuidOf('1')}`)
    await comparison()
    const user = userEvent.setup()

    await user.click(within(sideOf('A')).getByRole('button', { name: 'Clear Commit' }))
    await waitFor(() => expect(query().commit_a).toBeUndefined())
    await pick('Commit', 'c1', sideOf('A'))

    await waitFor(() => expect(runBox('2', 'A')).toBeChecked())
    expect(runBox('1', 'A')).toBeChecked()
    expect(query().runs_a).toBeUndefined()
  })

  it('selects a run that a side lists later, while every run is selected', async () => {
    const runs = { 'm1/c1': ['1', '2'], 'm1/c2': ['3'] }
    mockWorld({ runs })
    const { queryClient } = renderPage(COMPARED)
    await comparison()

    runs['m1/c2'] = ['3', '4']
    await act(() => queryClient.invalidateQueries())

    await waitFor(() => expect(runBox('4', 'B')).toBeChecked())
    expect(query().runs_b).toBeUndefined()
  })

  it('asks only for the samples of the runs selected', async () => {
    const sampled = mockWorld()
    renderPage(`${COMPARED}&runs_a=${uuidOf('1')}`)
    await comparison()

    expect([...sampled].sort()).toEqual(['1', '3'])
  })

  it('needs a run on each side', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    // Both of side A's runs, a range at a time with Shift (AR10).
    const user = userEvent.setup()
    await user.click(runBox('1', 'A'))
    await user.keyboard('{Shift>}')
    await user.click(runBox('2', 'A'))
    await user.keyboard('{/Shift}')

    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()
  })

  it("selects or deselects every run of a side from its list's header", async () => {
    mockWorld()
    renderPage(`${COMPARED}&runs_a=${uuidOf('1')}`)
    await comparison()
    const all = within(sideOf('A')).getByRole('checkbox', { name: 'Select all runs' })
    expect(all).toBePartiallyChecked()
    const user = userEvent.setup()

    await user.click(all)
    await waitFor(() => expect(runBox('2', 'A')).toBeChecked())
    expect(all).toBeChecked()
    expect(query().runs_a).toBeUndefined()

    await user.click(all)
    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()
    expect(runBox('1', 'A')).not.toBeChecked()
    expect(runBox('2', 'A')).not.toBeChecked()
  })

  it('combines each side’s runs with the run aggregation', async () => {
    mockWorld()
    renderPage(`${COMPARED}&run_agg=max`)

    expect((await comparison())[1]).toBe('a | 3 | 4 | 1 | +33.33% | 1.3333 | Regressed')
  })

  it('swaps the sides, with their runs selected', async () => {
    mockWorld()
    renderPage(`${COMPARED}&runs_a=${uuidOf('1')}`)
    await comparison()

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))

    await waitFor(async () =>
      expect((await comparison())[1]).toBe('a | 4 | 1 | -3 | -75.00% | 0.2500 | Improved'),
    )
    expect(query()).toMatchObject({ commit_a: ['c2'], commit_b: ['c1'], runs_b: [uuidOf('1')] })
    expect(query().runs_a).toBeUndefined()
    expect(runBox('2', 'B')).not.toBeChecked()
  })

  it('swaps two sides on the same commit, each keeping the runs it had', async () => {
    mockWorld()
    const commit = 'project_a=llvm&suite_a=libcxx&machine_a=m1&commit_a=c1&project_b=llvm&suite_b=libcxx&machine_b=m1&commit_b=c1'
    renderPage(
      `/compare?${commit}&metric=execution_time&runs_a=${uuidOf('1')}&runs_b=${uuidOf('2')}`,
    )
    expect((await comparison())[1]).toBe('a | 1 | 3 | 2 | +200.00% | 3.0000 | Regressed')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))

    await waitFor(async () =>
      expect((await comparison())[1]).toBe('a | 3 | 1 | -2 | -66.67% | 0.3333 | Improved'),
    )
    expect(query()).toMatchObject({ runs_a: [uuidOf('2')], runs_b: [uuidOf('1')] })
  })

  it('swaps a side with no run selected, which the URL cannot hold', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    await user.click(runBox('1', 'A'))
    await user.click(runBox('2', 'A'))
    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Swap sides' }))

    expect(await main().findByText('Select a run for side B.')).toBeInTheDocument()
    expect(runBox('1', 'B')).not.toBeChecked()
    expect(runBox('3', 'A')).toBeChecked()
    expect(query()).toMatchObject({ commit_a: ['c2'], commit_b: ['c1'] })
  })

  it('changes the swapped sides through their own controls', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await user.click(runBox('1', 'B'))

    await waitFor(() => expect(query().runs_b).toEqual([uuidOf('2')]))
    expect(query().runs_a).toBeUndefined()
    // Side B is now c1, of which only run 2 is selected.
    await waitFor(async () =>
      expect((await comparison())[1]).toBe('a | 4 | 3 | -1 | -25.00% | 0.7500 | Improved'),
    )
  })

  it('keeps the commit when another machine has runs at it, with every one selected', async () => {
    mockWorld()
    renderPage(`/compare?project_a=llvm&suite_a=libcxx&machine_a=m1&commit_a=c2`)
    expect(await screen.findByRole('checkbox', { name: /^Run 33333333/ })).toBeChecked()

    await pick('Machine', 'm2', sideOf('A'))

    expect(await screen.findByRole('checkbox', { name: /^Run 44444444/ })).toBeChecked()
    expect(query().commit_a).toEqual(['c2'])
  })

  it('clears the commit when another machine has no run at it', async () => {
    mockWorld()
    renderPage('/compare?project_a=llvm&suite_a=libcxx&machine_a=m1&commit_a=c1')
    await screen.findByRole('checkbox', { name: /^Run 11111111/ })

    await pick('Machine', 'm2', sideOf('A'))

    await waitFor(() => expect(query().commit_a).toBeUndefined())
    expect(query().machine_a).toEqual(['m2'])
  })
})

describe('the ways to the sides’ commits (CP1, AR20, AR21)', () => {
  const GITHUB = 'https://github.com/llvm/llvm-project'
  const commitButton = (side: 'A' | 'B', name: string) =>
    within(sideOf(side)).queryByRole('button', { name: `Commit ${name}` })
  const findCommitButton = (side: 'A' | 'B', name: string) =>
    within(sideOf(side)).findByRole('button', { name: `Commit ${name}` })
  const diff = () => main().queryByRole('link', { name: /^Diff/ })
  /** The link of `card` to the page of its commit, `value`. */
  const pageLink = (card: HTMLElement, value: string) =>
    within(card).getByRole('link', { name: value })
  /** Where the card of `side`'s ⓘ, named after `name`, leads for its commit, `value`. */
  const cardTarget = async (side: 'A' | 'B', name: string, value: string) =>
    pageLink(await commitCard(await findCommitButton(side, name)), value).getAttribute('href')

  it('give each side’s commit card from a ⓘ beside its picker, once it has one', async () => {
    mockWorld()
    const resolves = mockResolve()
    renderPage('/compare?project_a=llvm&suite_a=libcxx&machine_a=m1')
    await waitFor(() =>
      expect(within(sideOf('A')).getByRole('combobox', { name: 'Commit' })).toBeEnabled(),
    )
    expect(within(sideOf('A')).queryByRole('button', { name: /^Commit/ })).not.toBeInTheDocument()

    await pick('Commit', 'c1', sideOf('A'))

    // A button, rather than a link to the commit's page, which its card holds.
    const button = await findCommitButton('A', 'c1')
    expect(button).not.toHaveAttribute('href')
    expect(button).toHaveAttribute('aria-expanded', 'false')
    // Beside the picker's label, rather than in it.
    expect(within(sideOf('A')).getByRole('combobox', { name: 'Commit' })).toBeInTheDocument()
    // No longer a link into the repository, which the card holds.
    expect(within(sideOf('A')).queryByRole('link', { name: /^View/ })).not.toBeInTheDocument()
    // Only once both sides have a commit is there a range.
    expect(diff()).not.toBeInTheDocument()

    // The commit picked, as the picker listed it, without asking for it.
    const card = await commitCard(button)
    expect(card).toHaveAccessibleName('c1')
    expect(pageLink(card, 'c1')).toHaveAttribute('href', '/projects/llvm/suites/libcxx/commits/c1')
    expect(within(card).getByRole('link', { name: 'View on GitHub' })).toHaveAttribute(
      'href',
      `${GITHUB}/commit/c1`,
    )
    expect(resolves).toEqual([])
  })

  it('show the card of a commit restored from the URL as its picker looked it up', async () => {
    mockWorld({ revisions: { c1: 'r1', c2: 'r2' } })
    const resolves = mockResolve()
    renderPage(COMPARED)
    await comparison()

    const card = await commitCard(await findCommitButton('B', 'r2'))
    expect(card).toHaveAccessibleName('r2')
    expect(card).toHaveTextContent('c2')
    expect(resolves).toEqual([])
  })

  it.each([
    ['still pending', () => new Promise<never>(() => {})],
    ['has failed', () => errorResponse(500, 'internal_error', 'The lookup broke.')],
  ])(
    'show the card of a commit as resolved for it while its picker’s lookup is %s',
    async (_, answer) => {
      mockWorld({ revisions: { c1: 'r1', c2: 'r2' } })
      server.use(
        mockApi('get', '/api/projects/{project}/suites/{suite}/commits', ({ request }) => {
          const query = new URL(request.url).searchParams
          return query.get('commit') === 'c2' ? (answer() as never) : undefined
        }),
      )
      renderPage(COMPARED)

      // By its commit string, which is all that is known of it.
      const card = await commitCard(await findCommitButton('B', 'c2'))

      await waitFor(() => expect(card).toHaveAccessibleName('r2'))
    },
  )

  it("leave the commit picker's list to it while a card is open", async () => {
    mockWorld()
    const user = userEvent.setup()
    renderPage(COMPARED)
    await comparison()

    const card = await commitCard(await findCommitButton('A', 'c1'))
    await user.click(within(sideOf('A')).getByRole('button', { name: /Show suggestions.*Commit/ }))

    // Not hidden from assistive technology, as it would be were the card the combobox's popover.
    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(card).toBeInTheDocument()
  })

  it('link the changes from side A’s commit to side B’s, below the sides', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    expect(await cardTarget('B', 'c2', 'c2')).toBe('/projects/llvm/suites/libcxx/commits/c2')
    const link = main().getByRole('link', { name: 'Diff on GitHub: c1 → c2' })
    expect(link).toHaveAttribute('href', `${GITHUB}/compare/c1...c2`)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('name the commits by their display values', async () => {
    mockWorld({ revisions: { c1: 'r1', c2: 'r2' } })
    renderPage(COMPARED)
    await comparison()

    expect(await cardTarget('A', 'r1', 'c1')).toBe('/projects/llvm/suites/libcxx/commits/c1')
    const range = await main().findByRole('link', { name: 'Diff on GitHub: r1 → r2' })
    expect(range).toHaveAttribute('href', `${GITHUB}/compare/c1...c2`)
  })

  it('link the changes from side A’s commit to side B’s, even from the newer', async () => {
    mockWorld()
    renderPage(
      '/compare?project_a=llvm&suite_a=libcxx&machine_a=m1&commit_a=c2&project_b=llvm&suite_b=libcxx&machine_b=m1&commit_b=c1',
    )

    const link = await main().findByRole('link', { name: 'Diff on GitHub: c2 → c1' })
    expect(link).toHaveAttribute('href', `${GITHUB}/compare/c2...c1`)
  })

  it('link no changes between sides in different suites', async () => {
    const twin = { ...SUITE, name: 'twin' }
    mockWorld({ suites: [SUITE, twin] })
    renderPage(COMPARED.replace('suite_b=libcxx', 'suite_b=twin'))
    await comparison()

    expect(await cardTarget('A', 'c1', 'c1')).toBe('/projects/llvm/suites/libcxx/commits/c1')
    expect(await cardTarget('B', 'c2', 'c2')).toBe('/projects/llvm/suites/twin/commits/c2')
    expect(diff()).not.toBeInTheDocument()
  })

  it('link no changes when the suite has no template of their URL', async () => {
    mockWorld({ suites: [{ ...SUITE, repository: NO_REPOSITORY }] })
    renderPage(COMPARED)
    await comparison()

    expect(diff()).not.toBeInTheDocument()
    expect(commitButton('A', 'c1')).toBeInTheDocument()
  })
})

describe('the metric (CP1)', () => {
  it('offers only the numeric metrics both suites declare alike', async () => {
    mockWorld()
    renderPage('/compare?project_a=llvm&suite_a=other')
    const user = userEvent.setup()

    await waitFor(() => expect(selectButton('Metric')).toBeEnabled())
    await user.click(selectButton('Metric'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execution Time',
      'Compile Time',
    ])
    await user.keyboard('{Escape}')

    await pickSuite('Suite', 'llvm', 'libcxx', sideOf('B'))
    await user.click(selectButton('Metric'))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execution Time',
    ])
  })

  it('drops the metric when a suite picked does not offer it', async () => {
    mockWorld()
    renderPage('/compare?project_a=llvm&suite_a=other&metric=compile_time')
    await waitFor(() => expect(selectButton('Metric')).toHaveTextContent('Compile Time'))

    await pickSuite('Suite', 'llvm', 'libcxx', sideOf('B'))

    await waitFor(() => expect(query().metric).toBeUndefined())
    expect(selectButton('Metric')).toHaveTextContent('-- Select metric --')
  })

  it('says when no metric can be compared, and drops one the suites do not offer', async () => {
    mockWorld()
    renderPage('/compare?project_a=llvm&suite_a=libcxx&project_b=llvm&suite_b=millis&metric=execution_time')

    expect(await main().findByText('No metric can be compared.')).toBeInTheDocument()
    await waitFor(() => expect(query().metric).toBeUndefined())
  })

  it('compares a metric offered by the one suite that exists, dropping the other', async () => {
    mockWorld()
    renderPage('/compare?project_a=llvm&suite_a=libcxx&project_b=llvm&suite_b=bogus&metric=execution_time')

    await waitFor(() => expect(query().suite_b).toBeUndefined())
    expect(query().project_b).toBeUndefined()
    expect(query().metric).toEqual(['execution_time'])
    expect(selectButton('Metric')).toHaveTextContent('Execution Time')
  })
})

describe('the sample aggregation (CP1)', () => {
  it("combines a test's samples within each run", async () => {
    mockWorld({
      samples: {
        '1': [
          ['a', 1],
          ['a', 5],
        ],
        '2': [['a', 3]],
        '3': [['a', 4]],
      },
    })
    renderPage(`${COMPARED}&sample_agg=max`)

    // Per run, the largest are 5 and 3, whose median is 4.
    expect((await comparison())[1]).toBe('a | 4 | 4 | 0 | 0.00% | 1.0000 | Unchanged')
  })
})

describe('the summary bar (CP4)', () => {
  it('counts the tests in each category, with the share of the comparable ones', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    const bar = screen.getByRole('list', { name: 'Summary' })
    expect(
      within(bar)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Improved 0 (0%)',
      'Regressed 1 (100%)',
      'Noise 0 (0%)',
      'Unchanged 0 (0%)',
      'Only in A 1',
      'Only in B 1',
      'Zero baseline 0',
    ])
  })

  it('counts a zero baseline as such, though its status is N/A', async () => {
    mockWorld({ samples: { '1': [['a', 0]], '2': [['a', 0]], '3': [['a', 5]] } })
    renderPage(COMPARED)

    expect((await comparison())[1]).toBe('a | 0 | 5 | 5 | N/A | N/A | N/A')
    expect(screen.getByRole('list', { name: 'Summary' })).toHaveTextContent('Zero baseline 1')
  })
})

describe('loading (CP6)', () => {
  it('reports runs whose samples could not be loaded, and compares nothing until then', async () => {
    let fail = true
    mockWorld({
      sampleAnswer: (hex) =>
        hex === '3' && fail ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(COMPARED)

    expect(
      await screen.findByText(/The samples of a run could not be loaded: Boom/),
    ).toBeInTheDocument()
    expect(screen.queryByRole('table', { name: 'Comparison' })).not.toBeInTheDocument()

    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    expect(await comparison()).toEqual(ROWS)
  })

  it('reports runs that could not be listed, and waits for none', async () => {
    mockWorld({
      runsAnswer: (query) =>
        query.get('machine') === 'm1' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(COMPARED)

    expect(await screen.findAllByText(/The runs could not be listed: Boom/)).toHaveLength(2)
    expect(screen.queryByText(/Loading/)).not.toBeInTheDocument()
  })

  it('reports a commit that could not be looked up, keeping it', async () => {
    mockWorld()
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/commits', ({ request }) => {
        if (new URL(request.url).searchParams.get('commit') === 'c1')
          return errorResponse(500, 'internal_error', 'Boom') as never
      }),
    )
    renderPage(COMPARED)

    expect(
      await within(sideOf('A')).findByText(/The commit could not be looked up: Boom/),
    ).toBeInTheDocument()
    expect(query().commit_a).toEqual(['c1'])
    expect(await comparison()).toEqual(ROWS)
  })

  it('reports a failed lookup when the machines could not be listed either', async () => {
    mockWorld()
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/machines', () =>
        errorResponse(500, 'internal_error', 'No machines'),
      ),
      mockApi('get', '/api/projects/{project}/suites/{suite}/commits', ({ request }) => {
        if (new URL(request.url).searchParams.get('commit') === 'c1')
          return errorResponse(500, 'internal_error', 'Boom') as never
      }),
    )
    renderPage(COMPARED)

    expect(
      await screen.findAllByText(/The machines of llvm\/libcxx could not be listed/),
    ).not.toHaveLength(0)
    expect(
      await within(sideOf('A')).findByText(/The commit could not be looked up: Boom/),
    ).toBeInTheDocument()
  })

  it('says how many runs have their samples while they load', async () => {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    mockWorld()
    // Holding run 3's samples back, then answering as the world does.
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/runs/{uuid}/samples', async ({ params }) => {
        if (params.uuid === uuidOf('3')) await waiting
      }),
    )
    renderPage(COMPARED)

    expect(await screen.findByText('Loading samples: 2 of 3 runs...')).toBeInTheDocument()
    release()
    expect(await comparison()).toEqual(ROWS)
  })

  it('says only that the suites could not be listed, not what the sides miss', async () => {
    mockWorld()
    server.use(
      mockApi('get', '/api/projects', () =>
        errorResponse(500, 'internal_error', 'The suites broke.'),
      ),
    )
    renderPage(COMPARED)

    expect(
      await main().findByText(/The test suites could not be listed: The suites broke\./),
    ).toBeInTheDocument()
    expect(main().queryByText('Select a suite for side A.')).not.toBeInTheDocument()
    expect(selectButton('Metric')).toBeDisabled()
  })

  it('drops the runs of a side without a commit', async () => {
    mockWorld()
    renderPage(`/compare?project_b=llvm&suite_b=libcxx&machine_b=m1&runs_b=${uuidOf('3')}`)

    await waitFor(() => expect(query().runs_b).toBeUndefined())
    expect(query().machine_b).toEqual(['m1'])
  })

  it('drops a commit named without a machine, and a machine without a suite', async () => {
    mockWorld()
    renderPage(
      `/compare?project_a=llvm&suite_a=libcxx&commit_a=c1&runs_a=${uuidOf('1')}&machine_b=m1&commit_b=c2`,
    )

    await waitFor(() => expect(query().commit_a).toBeUndefined())
    expect(query().runs_a).toBeUndefined()
    expect(query().machine_b).toBeUndefined()
    expect(query().commit_b).toBeUndefined()
  })

  it('drops a machine that does not exist, without reporting its runs or profiles', async () => {
    mockWorld({
      runsAnswer: (query) =>
        query.get('machine') === 'bogus'
          ? errorResponse(404, 'not_found', 'No such machine')
          : undefined,
    })
    renderPage('/compare?project_a=llvm&suite_a=libcxx&machine_a=bogus&commit_a=c1')

    await waitFor(() => expect(query().machine_a).toBeUndefined())
    expect(query().commit_a).toBeUndefined()
    expect(screen.queryByText(/could not be (listed|looked up)/)).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/compare?project_a=llvm&suite_a=libcxx')
  })
})

/** Every URL the page is at from now on, as the URL shown changes. */
function urlsSeen() {
  const seen = [currentUrl()]
  const observer = new MutationObserver(() => seen.push(currentUrl()))
  observer.observe(screen.getByTestId('url'), { subtree: true, childList: true, characterData: true })
  return seen
}

/** Whether `url` names each side's project exactly when it names the side's suite. */
function pairsWhole(url: string | null) {
  const params = new URLSearchParams(url!.split('?')[1] ?? '')
  return ['a', 'b'].every((side) => params.has(`project_${side}`) === params.has(`suite_${side}`))
}

describe("a side's suite in the URL (CP7, AR22)", () => {
  it('drops a suite that does not exist with its project, and what depends on it, at once', async () => {
    mockWorld()
    renderPage(
      '/compare?project_a=llvm&suite_a=bogus&machine_a=m1&commit_a=c1' +
        '&project_b=llvm&suite_b=libcxx&machine_b=m1&commit_b=c2',
    )
    const seen = urlsSeen()

    await waitFor(() =>
      expect(currentUrl()).toBe(
        '/compare?project_b=llvm&suite_b=libcxx&machine_b=m1&commit_b=c2',
      ),
    )
    expect(seen.every(pairsWhole)).toBe(true)
  })

  it('drops a suite that exists in another project only', async () => {
    mockWorld()
    renderPage('/compare?project_a=other&suite_a=libcxx&machine_a=m1')

    await waitFor(() => expect(currentUrl()).toBe('/compare'))
  })

  it('keeps a suite it cannot check while the suites cannot be listed', async () => {
    mockWorld()
    server.use(
      mockApi('get', '/api/projects', () =>
        errorResponse(500, 'internal_error', 'The suites broke.'),
      ),
    )
    const url = '/compare?project_a=llvm&suite_a=bogus&machine_a=m1'
    renderPage(url)

    expect(await main().findByText(/The test suites could not be listed/)).toBeInTheDocument()
    await settle()
    expect(currentUrl()).toBe(url)
  })

  it('drops a suite named without its project, or a project without a suite, once listed', async () => {
    mockWorld()
    const listed = gate()
    mockSuites(SUITES, { wait: () => listed.promise })
    const url = '/compare?suite_a=libcxx&machine_a=m1&project_b=llvm'
    renderPage(url)
    const seen = urlsSeen()

    // Not before the suites are listed.
    await settle()
    expect(currentUrl()).toBe(url)
    listed.open()
    await waitFor(() => expect(currentUrl()).toBe('/compare'))
    expect(seen.slice(1).every(pairsWhole)).toBe(true)
  })

  it('tells apart suites of the same name in two projects', async () => {
    const other = inProject(SUITE, { name: 'other', display_name: null })
    mockWorld({ suites: [...SUITES, other] })
    renderPage('/compare')

    await pickSuite('Suite', 'other', 'libcxx', sideOf('A'))
    await waitFor(() => expect(query()).toEqual({ project_a: ['other'], suite_a: ['libcxx'] }))
    expect(selectButton('Suite', sideOf('A'))).toHaveTextContent('other/libcxx')

    await pickSuite('Suite', 'llvm', 'libcxx', sideOf('A'))
    await waitFor(() => expect(query()).toEqual({ project_a: ['llvm'], suite_a: ['libcxx'] }))
  })
})
