import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import type { PlotData, PlotHoverEvent, PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import { currentUrl, headersOf, main, query, renderPage, search, table } from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { mockClipboard } from '../../test/clipboard'
import { uuidOf } from '../../test/fixtures'
import type { PlotGeometry } from '../../components/chart'
import { chartProps } from '../../test/chart-props'
import { COMPARED, comparison, mockWorld, pick, runBox } from './compare-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** What the page last handed its chart. */
const chart = () => chartProps(screen.getByRole('img', { name: /^Ratio of B to A/ }))

/** The bars of the chart, as their log2 ratios. */
const barsOf = () => (chart().data[0] as PlotData).y as number[]

/** The comparison of COMPARED: a is regressed, b is on side A only, c on side B only. */
const ROWS = [
  'Geomean | 2 | 4 | 2 | +100.00% | 2.0000 | Regressed',
  'a | 2 | 4 | 2 | +100.00% | 2.0000 | Regressed',
  'b | 2 | N/A | N/A | N/A | N/A | N/A',
  'c | N/A | 5 | N/A | N/A | N/A | N/A',
]

describe('the Compare page (CP1)', () => {
  it('says what it needs before it can compare, a step at a time', async () => {
    mockWorld()
    renderPage('/compare')

    expect(await main().findByText('Select a suite for side A.')).toBeInTheDocument()
    expect(main().getByText('Select a suite to load metrics...')).toBeInTheDocument()
    await pickOption('Suite A', 'libcxx')
    expect(await main().findByText('Select a machine for side A.')).toBeInTheDocument()
    await pick('Machine A', 'm1')
    expect(await main().findByText('Select a commit for side A.')).toBeInTheDocument()
    await pick('Commit A', 'c1')
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

    await user.click(screen.getByRole('button', { name: 'Clear Commit A' }))
    await waitFor(() => expect(query().commit_a).toBeUndefined())
    await pick('Commit A', 'c1')

    await waitFor(() => expect(runBox('2', 'A')).toBeChecked())
    expect(runBox('1', 'A')).toBeChecked()
    expect(query().runs_a).toBeUndefined()
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

    await userEvent
      .setup()
      .click(screen.getByRole('checkbox', { name: 'Select all runs of side A' }))

    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()
  })

  it('combines the runs with each side’s run aggregation', async () => {
    mockWorld()
    renderPage(`${COMPARED}&run_agg_a=max`)

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
    await user.click(screen.getByRole('checkbox', { name: 'Select all runs of side A' }))
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

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))
    await pickOption('Run aggregation B', 'max')

    await waitFor(() => expect(query().run_agg_b).toEqual(['max']))
    expect(query().run_agg_a).toBeUndefined()
    // Side B is now c1, whose largest value of a is run 2's.
    await waitFor(async () =>
      expect((await comparison())[1]).toBe('a | 4 | 3 | -1 | -25.00% | 0.7500 | Improved'),
    )
  })

  it('keeps the commit when another machine has runs at it, with every one selected', async () => {
    mockWorld()
    renderPage(`/compare?suite_a=libcxx&machine_a=m1&commit_a=c2`)
    expect(await screen.findByRole('checkbox', { name: /^Run 33333333/ })).toBeChecked()

    await pick('Machine A', 'm2')

    expect(await screen.findByRole('checkbox', { name: /^Run 44444444/ })).toBeChecked()
    expect(query().commit_a).toEqual(['c2'])
  })

  it('clears the commit when another machine has no run at it', async () => {
    mockWorld()
    renderPage('/compare?suite_a=libcxx&machine_a=m1&commit_a=c1')
    await screen.findByRole('checkbox', { name: /^Run 11111111/ })

    await pick('Machine A', 'm2')

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

    await pickOption('Suite B', 'libcxx')
    await user.click(screen.getByRole('button', { name: /Metric$/ }))
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Execution Time',
    ])
  })

  it('drops the metric when a suite picked does not offer it', async () => {
    mockWorld()
    renderPage('/compare?suite_a=other&metric=compile_time')
    expect(await screen.findByRole('button', { name: /Metric$/ })).toHaveTextContent('Compile Time')

    await pickOption('Suite B', 'libcxx')

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

describe('the comparison table (CP2)', () => {
  it('sorts by Delta % descending by default, N/A last, and by any column on request', async () => {
    mockWorld({
      samples: {
        '1': [
          ['a', 1],
          ['b', 2],
          ['c', 0],
        ],
        '2': [['a', 1]],
        '3': [
          ['a', 2],
          ['b', 1],
          ['c', 1],
        ],
      },
    })
    renderPage(COMPARED)

    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'a',
      'b',
      'c',
    ])
    await userEvent.setup().click(screen.getByRole('button', { name: /^Test/ }))
    expect(query().sort).toEqual(['test'])
    await userEvent.setup().click(screen.getByRole('button', { name: /^Delta %/ }))
    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'b',
      'a',
      'c',
    ])
    expect(query().sort).toEqual(['delta_pct'])
  })

  it('says how many samples and runs make each value', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    const row = screen.getAllByRole('row')[2]
    expect(within(row).getAllByText('2', { selector: '[title]' })[0]).toHaveAttribute(
      'title',
      '2 samples across 2 runs',
    )
    expect(within(row).getByText('+100.00%')).toHaveAttribute(
      'title',
      'A: 2 samples across 2 runs, B: 1 sample across 1 run',
    )
  })

  it('filters the tests by name, which the geomean and the summary follow', async () => {
    mockWorld()
    renderPage(COMPARED)
    await comparison()

    search('Filter tests', 'b')

    await waitFor(async () =>
      expect(await comparison()).toEqual([
        'Geomean | N/A | N/A | N/A | N/A | N/A | N/A',
        'b | 2 | N/A | N/A | N/A | N/A | N/A',
      ]),
    )
    expect(screen.getByText('1 of 1 matching tests shown (3 total)')).toBeInTheDocument()
    await waitFor(() => expect(query().test_filter).toEqual(['b']))
  })

  it('says when no test matches the filter', async () => {
    mockWorld()
    renderPage(`${COMPARED}&test_filter=zzz`)

    expect(await screen.findByText('No tests match the filter.')).toBeInTheDocument()
  })
})

/** A comparison in which a changes by 0.5% and d by 50%, b and c being on one side only. */
const NOISY = {
  samples: {
    '1': [
      ['a', 100],
      ['b', 2],
      ['d', 2],
    ],
    '2': [
      ['a', 100],
      ['d', 2],
    ],
    '3': [
      ['a', 100.5],
      ['c', 5],
      ['d', 3],
    ],
  } as Record<string, [string, number][]>,
}

const statusOf = async (test: string) =>
  (await comparison())
    .find((row) => row.startsWith(`${test} |`))
    ?.split(' | ')
    .at(-1)

describe('noise (CP1)', () => {
  it('classifies as noise the tests a knob catches, saying why on hover', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)

    expect(await statusOf('a')).toBe('Noise')
    expect(await statusOf('d')).toBe('Regressed')
    expect(screen.getByText('Noise', { selector: '[title]' })).toHaveAttribute(
      'title',
      'Delta 0.5% below 1% threshold',
    )
  })

  it('enables a knob with its value, and applies a value typed once typing pauses', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await waitFor(() => expect(query().noise_pct).toEqual(['1']))
    await waitFor(async () => expect(await statusOf('a')).toBe('Noise'))

    const threshold = screen.getByRole('textbox', { name: 'Delta % below threshold' })
    await user.clear(threshold)
    await user.type(threshold, '60')
    // Once typing pauses.
    await waitFor(() => expect(query().noise_pct).toEqual(['60']), { timeout: 2000 })
    await waitFor(async () => expect(await statusOf('d')).toBe('Noise'))

    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await waitFor(() => expect(query().noise_pct).toBeUndefined())
    await waitFor(async () => expect(await statusOf('d')).toBe('Regressed'))
  })

  it('applies only the value typed once typing pauses, and none once disabled meanwhile', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))
    const threshold = screen.getByRole('textbox', { name: 'Delta % below threshold' })

    await user.clear(threshold)
    await user.type(threshold, '60')
    // Not yet: neither 6 on the way, nor 60.
    expect(query().noise_pct).toEqual(['1'])
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().noise_pct).toBeUndefined()

    // Enabled again, with the value typed.
    await user.click(screen.getByRole('checkbox', { name: 'Delta % below' }))
    expect(query().noise_pct).toEqual(['60'])
  })

  it('starts collapsed, and hides the noise on request', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()

    expect(screen.getByRole('button', { name: /Noise filtering/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    )
    expect(screen.queryByRole('checkbox', { name: 'Delta % below' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))

    expect(query().hide_noise).toEqual(['true'])
    await waitFor(async () => expect(await statusOf('a')).toBeUndefined())
  })

  it('lists every knob that classified a test as noise', async () => {
    mockWorld({
      samples: {
        '1': [
          ['a', 1],
          ['a', 2],
        ],
        '2': [['a', 1]],
        '3': [
          ['a', 1.004],
          ['a', 2],
        ],
      },
    })
    renderPage(`${COMPARED}&noise_pct=50&noise_pval=0.05&noise_floor=10`)

    expect(await statusOf('a')).toBe('Noise')
    expect(screen.getByText('Noise', { selector: '[title]' }).getAttribute('title')).toMatch(
      /^Delta .*% below 50% threshold\np-value .* above 0.05\nmax\(\|A\|, \|B\|\) = .* below floor of 10$/,
    )
  })

  it('keeps applying the last valid value while the text is not one', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pval=0.05`)
    await comparison()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Noise filtering/ }))

    const threshold = screen.getByRole('textbox', { name: 'P-value above threshold' })
    await user.clear(threshold)
    await user.type(threshold, '2')

    expect(threshold).toHaveAttribute('aria-invalid', 'true')
    await new Promise((resolve) => setTimeout(resolve, SEARCH_DELAY_MS + 100))
    expect(query().noise_pval).toEqual(['0.05'])
  })

  it('leaves a knob disabled when the URL gives it a value it does not accept', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pval=2&noise_floor=abc`)
    await comparison()

    await waitFor(() => expect(query().noise_pval).toBeUndefined())
    expect(query().noise_floor).toBeUndefined()
  })

  it('hides the noise from the table, but not from the summary bar', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1&hide_noise=true`)

    expect((await comparison()).map((row) => row.split(' | ')[0])).toEqual([
      'Geomean',
      'd',
      'b',
      'c',
    ])
    expect(screen.getByText('3 of 3 tests shown')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Summary' })).toHaveTextContent('Noise 1 (50%)')
  })

  it('says when every matching test is classified as noise', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1&hide_noise=true&test_filter=a`)

    expect(
      await screen.findByText('Every matching test is classified as noise.'),
    ).toBeInTheDocument()
  })
})

/** The checkbox showing `test`'s row (CP2 "Hidden tests"). */
const showBox = (test: string) => screen.getByRole('checkbox', { name: `Show ${test}` })

/** The tests the comparison table lists, in order, without the geomean. */
const listedTests = async () => (await comparison()).slice(1).map((row) => row.split(' | ')[0])

describe('hidden tests (CP2)', () => {
  it('hides a test from the comparison, but not from the table', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(showBox('d'))

    expect(await listedTests()).toEqual(['d', 'a', 'b', 'c'])
    expect(screen.getByText('3 of 4 tests shown')).toBeInTheDocument()
    await waitFor(() => expect(query().hidden_test).toEqual(['d']))
    // The geomean is a's alone.
    expect((await comparison())[0]).toBe(
      'Geomean | 100 | 100.5 | 0.5 | +0.50% | 1.0050 | Regressed',
    )
  })

  it('hides a test with a click on its row, and leaves it hidden whatever the filter', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=1`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('cell', { name: 'd' }))
    expect(showBox('d')).not.toBeChecked()
    search('Filter tests', 'b')
    await waitFor(async () => expect(await listedTests()).toEqual(['b']))
    search('Filter tests', '')
    await waitFor(async () => expect(await listedTests()).toHaveLength(4))
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))
    await waitFor(async () => expect(await listedTests()).toEqual(['d', 'b', 'c']))

    expect(showBox('d')).not.toBeChecked()
    expect(query().hidden_test).toEqual(['d'])
  })

  it('hides a range of the rows as they are sorted, with Shift held', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(showBox('d'))
    await user.keyboard('{Shift>}')
    await user.click(showBox('b'))
    await user.keyboard('{/Shift}')

    await waitFor(() => expect(query().hidden_test).toEqual(['a', 'b', 'd']))
    expect(showBox('c')).toBeChecked()
  })

  it('hides or shows every row from the header', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&test_filter=a`)
    await comparison()
    const user = userEvent.setup()
    const header = screen.getByRole('checkbox', { name: 'Show all tests shown' })

    await user.click(header)
    await waitFor(() => expect(query().hidden_test).toEqual(['a']))
    expect(screen.getByText('0 of 1 matching tests shown (4 total)')).toBeInTheDocument()
    await user.click(header)
    await waitFor(() => expect(query().hidden_test).toBeUndefined())
  })

  it('shows a test alone with a double-click, and every test again with another', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['b', 'c', 'd']))
    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toBeUndefined())
  })

  it('restores the hidden tests of the URL, forgetting those the comparison does not hold', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=d&hidden_test=zzz`)
    await comparison()

    expect(showBox('d')).not.toBeChecked()
    await waitFor(() => expect(query().hidden_test).toEqual(['d']))
  })

  it('keeps the hidden tests while a side has no run selected', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=b`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: 'Select all runs of side A' }))
    expect(await main().findByText('Select a run for side A.')).toBeInTheDocument()
    await user.click(runBox('1', 'A'))

    await comparison()
    expect(showBox('b')).not.toBeChecked()
    expect(query().hidden_test).toEqual(['b'])
  })

  it('offers nothing to copy when every row is hidden', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Copy as CSV' })).not.toBeInTheDocument(),
    )
  })

  it('says when there are too many hidden tests for the URL', async () => {
    const tests = Array.from({ length: 12 }, (_, i): [string, number] => [`t${i}`, i + 1])
    mockWorld({ samples: { '1': tests, '2': tests, '3': tests } })
    renderPage(COMPARED)
    await comparison()

    await userEvent.setup().click(screen.getByRole('checkbox', { name: 'Show all tests shown' }))

    expect(await screen.findByText('(too many hidden to reflect in the URL)')).toBeInTheDocument()
    expect(query().hidden_test).toBeUndefined()
  })
})

describe('optional columns (CP2)', () => {
  it('adds the columns of a statistic from the Columns menu, which stays open', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Mean' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Samples' }))

    expect(screen.getByRole('menu')).toBeInTheDocument()
    await waitFor(() => expect(query().columns).toEqual(['samples', 'mean']))
    await user.keyboard('{Escape}')
    expect(headersOf(await table('Comparison')).slice(1)).toEqual([
      'Test',
      'Value A',
      'Value B',
      'Delta',
      // Sorted by it, descending.
      'Delta %▼',
      'Ratio',
      'Samples A',
      'Samples B',
      'Mean A',
      'Mean B',
      'Status',
    ])
  })

  it("shows each side's statistics, empty on the geomean and N/A without samples", async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&columns=mean&columns=pvalue`)

    const rows = await comparison()
    // The geomean's statistics are empty.
    expect(rows[0].split(' | ').slice(6)).toEqual(['', '', '', '', '', 'Regressed'])
    expect(rows.find((row) => row.startsWith('b |'))).toBe(
      'b | 2 | N/A | N/A | N/A | N/A | 1 | 0 | 2 | N/A | N/A | N/A',
    )
    expect(rows.find((row) => row.startsWith('d |'))).toBe(
      'd | 2 | 3 | 1 | +50.00% | 1.5000 | 2 | 1 | 2 | 3 | N/A | Regressed',
    )
  })

  it('sorts by a statistic, back to the default sort once its column is hidden', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=mean&sort=-mean_a`)
    expect(await listedTests()).toEqual(['a', 'b', 'd', 'c'])
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Mean' }))
    await user.keyboard('{Escape}')

    await waitFor(() => expect(query().sort).toBeUndefined())
    expect(await listedTests()).toEqual(['d', 'a', 'b', 'c'])
  })

  it('shows the p-value whether or not its knob is enabled, 0 for a deterministic change', async () => {
    const tight = (base: number) =>
      [0, 1, 2, 1, 0].map((i): [string, number] => ['b', base + i / 100])
    mockWorld({
      samples: {
        '1': [['a', 2], ['a', 2], ...tight(1)],
        '2': [],
        '3': [['a', 3], ['a', 3], ...tight(2)],
      },
    })
    renderPage(`${COMPARED}&columns=pvalue`)

    const rows = await comparison()
    expect(
      rows
        .find((row) => row.startsWith('a |'))
        ?.split(' | ')
        .at(-2),
    ).toBe('0')
    // A tiny p-value, in exponent notation.
    expect(
      rows
        .find((row) => row.startsWith('b |'))
        ?.split(' | ')
        .at(-2),
    ).toMatch(/^\d\.\d\de-\d+$/)
  })

  it('sorts by a statistic from its header, and keeps the sort when another column goes', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&columns=mean`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: /^Mean B/ }))
    await waitFor(() => expect(query().sort).toEqual(['mean_b']))
    expect(await listedTests()).toEqual(['d', 'c', 'a', 'b'])

    await user.click(screen.getByRole('button', { name: 'Columns' }))
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Samples' }))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(query().columns).toEqual(['mean']))
    expect(query().sort).toEqual(['mean_b'])
  })

  it('is used from the keyboard, finding a statistic by its name', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    screen.getByRole('button', { name: 'Columns' }).focus()
    await user.keyboard('{Enter}')
    // Typing moves to the statistic whose name starts with what is typed. A space would be taken as
    // more of it, so Enter toggles it.
    await user.keyboard('st')
    await user.keyboard('{Enter}')

    await waitFor(() => expect(query().columns).toEqual(['stddev']))
  })

  it('drops a sort by a column that is not shown', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&sort=mean_a`)
    await comparison()

    await waitFor(() => expect(query().sort).toBeUndefined())
  })

  it('copies the statistics shown as CSV', async () => {
    const writeText = mockClipboard()
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&hidden_test=a&hidden_test=b&hidden_test=c`)
    await comparison()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const [header, geomean, ...lines] = writeText.mock.calls[0][0].split('\r\n')
    expect(header).toBe('Test,Value A,Value B,Delta,Delta %,Ratio,Samples A,Samples B,Status')
    // Empty statistics on the geomean, whose values are d's, at full precision.
    expect(geomean).toMatch(/^Geomean,2,[\d.]+,[\d.]+,[\d.]+,[\d.]+,,,Regressed$/)
    expect(lines).toEqual(['d,2,3,1,50,1.5,2,1,Regressed'])
  })
})

describe('Copy as CSV (CP2)', () => {
  it('copies the compared rows, in the order they are sorted in, with the geomean first', async () => {
    const writeText = mockClipboard()
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=b`)
    await comparison()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const [header, geomean, ...lines] = writeText.mock.calls[0][0].split('\r\n')
    expect(header).toBe('Test,Value A,Value B,Delta,Delta %,Ratio,Status')
    // At full precision: the geomeans of 2 and 100, and of 3 and 100.5.
    expect(geomean).toMatch(
      /^Geomean,14\.14213562373095\d*,17\.3637553541853\d*,[\d.]+,[\d.]+,[\d.]+,Regressed$/,
    )
    expect(lines).toEqual([
      'd,2,3,1,50,1.5,Regressed',
      'a,100,100.5,0.5,0.5,1.005,Regressed',
      'c,,5,,,,',
    ])
  })
})

describe('the Profile column (CP2)', () => {
  /** The runs of COMPARED with profiles, by hex: those of side A (1, 2), and side B's (3). */
  const PROFILES = { '1': ['a', 'b'], '2': ['a'], '3': ['a', 'c'] }

  /** The Profile links of the comparison table, by the test of their row. */
  async function profileLinks() {
    const rows = within(await table('Comparison')).getAllByRole('row').slice(1)
    return Object.fromEntries(
      rows.flatMap((row) => {
        const link = within(row).queryByRole('link', { name: 'Profile' })
        const test = within(row).getAllByRole('cell')[1].textContent
        return link === null ? [] : [[test, link.getAttribute('href')]]
      }),
    )
  }

  /** The Profiles page's URL, with each side given as `[run hex, test]`. */
  function profilesUrl(...sides: [string, string][]) {
    const letters = ['a', 'b']
    const params = sides.flatMap(([hex, test], i) => [
      [`suite_${letters[i]}`, 'libcxx'],
      [`run_${letters[i]}`, uuidOf(hex)],
      [`test_${letters[i]}`, test],
    ])
    return `/profiles?${new URLSearchParams(params)}`
  }

  it("links each test to the latest selected run's profile on each side", async () => {
    mockWorld({ profiles: PROFILES })
    renderPage(COMPARED)

    // A test with a profile on side B only has it shown on side A of the Profiles page.
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({
        a: profilesUrl(['2', 'a'], ['3', 'a']),
        b: profilesUrl(['1', 'b']),
        c: profilesUrl(['3', 'c']),
      }),
    )
    expect(screen.getByRole('columnheader', { name: 'Profile' })).toBeInTheDocument()
  })

  it('follows the runs selected', async () => {
    mockWorld({ profiles: PROFILES })
    renderPage(COMPARED)
    await waitFor(async () => expect(Object.keys(await profileLinks())).toHaveLength(3))

    await userEvent.setup().click(runBox('2', 'A'))
    await waitFor(async () =>
      expect((await profileLinks()).a).toBe(profilesUrl(['1', 'a'], ['3', 'a'])),
    )
  })

  it('is not shown when no test compared has a profile', async () => {
    mockWorld({ profiles: { '1': ['elsewhere'] } })
    renderPage(COMPARED)

    expect(await comparison()).toEqual(ROWS)
    expect(screen.queryByRole('columnheader', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('says when profiles could not be listed, linking those of the other side', async () => {
    let fail = true
    mockWorld({
      profiles: PROFILES,
      profilesAnswer: (hex) =>
        hex === '3' && fail ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(COMPARED)

    expect(
      await screen.findByText(/The profiles could not be listed: Boom/),
    ).toBeInTheDocument()
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({
        a: profilesUrl(['2', 'a']),
        b: profilesUrl(['1', 'b']),
      }),
    )

    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(async () =>
      expect((await profileLinks()).c).toBe(profilesUrl(['3', 'c'])),
    )
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
  })

  it('says when the runs with profiles could not be listed, still comparing', async () => {
    mockWorld({
      profiles: PROFILES,
      runsAnswer: (query) =>
        query.has('has_profiles') ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    })
    renderPage(COMPARED)

    expect(
      await screen.findAllByText(/The profiles could not be listed: Boom/),
    ).toHaveLength(1)
    expect((await comparison()).length).toBe(ROWS.length)
  })
})

describe('the chart (CP3)', () => {
  it('plots a bar per compared test that can be, by ratio', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    // b and c have a value on one side only.
    expect(barsOf()).toEqual([Math.log2(1.005), Math.log2(1.5)])

    await userEvent.setup().click(showBox('d'))
    await waitFor(() => expect(barsOf()).toEqual([Math.log2(1.005)]))
  })

  it("draws the Delta % knob's noise band", async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&noise_pct=5`)
    await comparison()

    expect(chart().layout.shapes?.map((shape) => shape.y0)).toEqual([
      Math.log2(1.05),
      Math.log2(0.95),
    ])
  })

  it('says when there is nothing to plot', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&hidden_test=a&hidden_test=d`)
    await comparison()

    expect(chart().layout.annotations?.[0].text).toBe('No data to plot')
    expect(screen.getByRole('img', { name: 'Ratio of B to A by test: no data to plot' }))
  })

  it('labels the y-axis with the percentage changes of the range zoomed to, until reset', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const ticks = () => chart().layout.yaxis?.ticktext

    expect(ticks()).toContain('+50%')
    act(() =>
      chart().onRelayout?.({
        'yaxis.range[0]': Math.log2(0.98),
        'yaxis.range[1]': Math.log2(1.02),
      } as PlotRelayoutEvent),
    )
    expect(ticks()).toContain('+1%')
    expect(ticks()).not.toContain('+50%')

    act(() => chart().onRelayout?.({ 'yaxis.autorange': true } as PlotRelayoutEvent))
    expect(ticks()).toContain('+50%')
  })

  it('keeps a zoom across settings, until the comparison is replaced', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()
    const ticks = () => chart().layout.yaxis?.ticktext
    const zoom = () =>
      act(() =>
        chart().onRelayout?.({
          'yaxis.range[0]': Math.log2(0.98),
          'yaxis.range[1]': Math.log2(1.02),
        } as PlotRelayoutEvent),
      )

    zoom()
    const zoomed = ticks()
    const revision = chart().layout.uirevision
    await pickOption('Sample aggregation', 'max')
    search('Filter tests', 'a')
    await user.click(screen.getByRole('checkbox', { name: 'Hide noise' }))
    await waitFor(() => expect(query()).toMatchObject({ hide_noise: ['true'], test_filter: ['a'] }))
    expect(ticks()).toEqual(zoomed)
    expect(chart().layout.uirevision).toBe(revision)

    // Swapped there and back: Plotly forgets the zoom as soon as the comparison is another.
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await user.click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(() => expect(ticks()).not.toEqual(zoomed))

    zoom()
    await user.click(runBox('2', 'A'))
    await waitFor(() => expect(ticks()).not.toEqual(zoomed))
  })

  it('plots only the tests the filter keeps', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()

    search('Filter tests', 'd')

    await waitFor(() => expect(barsOf()).toEqual([Math.log2(1.5)]))
  })

  it('highlights the row of the bar hovered, and outlines the bar of the row hovered', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const name = (test: string) => screen.getByRole('cell', { name: test }).querySelector('span')
    const event = (index: number) =>
      ({ points: [{ data: chart().data[0], pointNumber: index }] }) as unknown as PlotMouseEvent &
        PlotHoverEvent
    // Where the plot draws, as the chart reports it once drawn: a slot of 100 pixels per bar.
    const geometry: PlotGeometry = {
      area: { left: 0, top: 0, width: 200, height: 100 },
      x: (value) => 50 + 100 * value,
      y: (value) => 50 - 50 * value,
    }
    act(() => chart().onDraw?.(geometry))
    const outline = () => document.querySelector('svg rect')

    act(() => chart().onHover?.(event(1)))
    expect(name('d')).toHaveClass('hovered')
    act(() => chart().onUnhover?.(event(1)))
    expect(name('d')).not.toHaveClass('hovered')

    const data = chart().data
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'a' }).closest('tr')!)
    // a's bar, the first, as wide as the bar itself.
    expect(outline()).toHaveAttribute('x', '5')
    expect(outline()).toHaveAttribute('width', '90')
    // The bars themselves are left as they are.
    expect(chart().data).toBe(data)

    // b has no bar to outline.
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'b' }).closest('tr')!)
    expect(outline()).toBeNull()
    fireEvent.mouseEnter(screen.getByRole('cell', { name: 'd' }).closest('tr')!)
    fireEvent.mouseLeave(screen.getByRole('table', { name: 'Comparison' }).parentElement!)
    expect(outline()).toBeNull()
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

  it('drops the runs of a side without a commit', async () => {
    mockWorld()
    renderPage(`/compare?suite_b=libcxx&machine_b=m1&runs_b=${uuidOf('3')}`)

    await waitFor(() => expect(query().runs_b).toBeUndefined())
    expect(query().machine_b).toEqual(['m1'])
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
