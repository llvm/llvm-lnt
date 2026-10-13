import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import { currentUrl, main, query, renderPage } from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { uuidOf } from '../../test/fixtures'
import { COMPARED, comparison, mockWorld, pick, ROWS, runBox, sideOf } from './compare-world'

// The page renders its chart, which Plotly cannot draw in jsdom (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

describe('the Compare page (CP1)', () => {
  it('says what it needs before it can compare, a step at a time', async () => {
    mockWorld()
    renderPage('/compare')

    expect(await main().findByText('Select a suite for side A.')).toBeInTheDocument()
    expect(main().getByText('Select a suite to load metrics...')).toBeInTheDocument()
    await pickOption('Suite', 'libcxx', sideOf('A'))
    expect(await main().findByText('Select a machine for side A.')).toBeInTheDocument()
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
    const commit = 'suite_a=libcxx&machine_a=m1&commit_a=c1&suite_b=libcxx&machine_b=m1&commit_b=c1'
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
    renderPage(`/compare?suite_a=libcxx&machine_a=m1&commit_a=c2`)
    expect(await screen.findByRole('checkbox', { name: /^Run 33333333/ })).toBeChecked()

    await pick('Machine', 'm2', sideOf('A'))

    expect(await screen.findByRole('checkbox', { name: /^Run 44444444/ })).toBeChecked()
    expect(query().commit_a).toEqual(['c2'])
  })

  it('clears the commit when another machine has no run at it', async () => {
    mockWorld()
    renderPage('/compare?suite_a=libcxx&machine_a=m1&commit_a=c1')
    await screen.findByRole('checkbox', { name: /^Run 11111111/ })

    await pick('Machine', 'm2', sideOf('A'))

    await waitFor(() => expect(query().commit_a).toBeUndefined())
    expect(query().machine_a).toEqual(['m2'])
  })
})

describe('the metric (CP1)', () => {
  it('offers only the numeric metrics both suites declare alike', async () => {
    mockWorld()
    renderPage('/compare?suite_a=other')
    const user = userEvent.setup()

    await user.click(await screen.findByRole('button', { name: /Metric$/ }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execution Time',
      'Compile Time',
    ])
    await user.keyboard('{Escape}')

    await pickOption('Suite', 'libcxx', sideOf('B'))
    await user.click(screen.getByRole('button', { name: /Metric$/ }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execution Time',
    ])
  })

  it('drops the metric when a suite picked does not offer it', async () => {
    mockWorld()
    renderPage('/compare?suite_a=other&metric=compile_time')
    expect(await screen.findByRole('button', { name: /Metric$/ })).toHaveTextContent('Compile Time')

    await pickOption('Suite', 'libcxx', sideOf('B'))

    await waitFor(() => expect(query().metric).toBeUndefined())
    expect(selectButton('Metric')).toHaveTextContent('-- Select metric --')
  })

  it('says when no metric can be compared, and drops one the suites do not offer', async () => {
    mockWorld()
    renderPage('/compare?suite_a=libcxx&suite_b=millis&metric=execution_time')

    expect(await main().findByText('No metric can be compared.')).toBeInTheDocument()
    await waitFor(() => expect(query().metric).toBeUndefined())
  })

  it('compares a metric offered by the one suite that exists, dropping the other', async () => {
    mockWorld()
    renderPage('/compare?suite_a=libcxx&suite_b=bogus&metric=execution_time')

    await waitFor(() => expect(query().suite_b).toBeUndefined())
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
      'N/A 0',
    ])
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

  it('says how many runs have their samples while they load', async () => {
    let release = () => {}
    const waiting = new Promise<void>((resolve) => (release = resolve))
    mockWorld()
    // Holding run 3's samples back, then answering as the world does.
    server.use(
      mockApi('get', '/api/suites/{testsuite}/runs/{uuid}/samples', async ({ params }) => {
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
      mockApi('get', '/api/suites', () =>
        errorResponse(500, 'internal_error', 'The suites broke.'),
      ),
    )
    renderPage(COMPARED)

    expect(
      await main().findByText(/The test suites could not be listed: The suites broke\./),
    ).toBeInTheDocument()
    expect(main().queryByText('Select a suite for side A.')).not.toBeInTheDocument()
    expect(main().queryByText('Select a suite to load metrics...')).not.toBeInTheDocument()
  })

  it('drops the runs of a side without a commit', async () => {
    mockWorld()
    renderPage(`/compare?suite_b=libcxx&machine_b=m1&runs_b=${uuidOf('3')}`)

    await waitFor(() => expect(query().runs_b).toBeUndefined())
    expect(query().machine_b).toEqual(['m1'])
  })

  it('drops a commit named without a machine, and a machine without a suite', async () => {
    mockWorld()
    renderPage(
      `/compare?suite_a=libcxx&commit_a=c1&runs_a=${uuidOf('1')}&machine_b=m1&commit_b=c2`,
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
    renderPage('/compare?suite_a=libcxx&machine_a=bogus&commit_a=c1')

    await waitFor(() => expect(query().machine_a).toBeUndefined())
    expect(query().commit_a).toBeUndefined()
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/compare?suite_a=libcxx')
  })
})
