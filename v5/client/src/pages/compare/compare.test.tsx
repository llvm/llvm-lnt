import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import { currentUrl, main, query, renderPage, search } from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { SEARCH_DELAY_MS } from '../../components/suggestions'
import { mockClipboard } from '../../test/clipboard'
import { uuidOf } from '../../test/fixtures'
import { COMPARED, comparison, mockWorld, pick, runBox } from './compare-world'

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
      runsAnswer: (machine) =>
        machine === 'm1' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
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

  it('drops a machine that does not exist, without reporting its runs', async () => {
    mockWorld()
    renderPage('/compare?suite_a=libcxx&machine_a=bogus&commit_a=c1')

    await waitFor(() => expect(query().machine_a).toBeUndefined())
    expect(query().commit_a).toBeUndefined()
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
    expect(currentUrl()).toBe('/compare?suite_a=libcxx')
  })
})
