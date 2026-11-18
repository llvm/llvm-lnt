import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { errorResponse, mockApi } from '../../test/mock-api'
import { server } from '../../test/server'
import { headersOf, main, query, renderPage, search, settle, table } from '../../test/page'
import { mockClipboard } from '../../test/clipboard'
import { fakeLayout } from '../../test/layout'
import { resize } from '../../test/resize-observer'
import { uuidOf } from '../../test/fixtures'
import { STATISTICS_OVER } from './columns'
import {
  CLASSIFIED,
  COMPARED,
  comparison,
  listedTests,
  mockWorld,
  NOISY,
  ROWS,
  runBox,
  showBox,
} from './compare-world'

// The page renders its chart, which Plotly cannot draw in jsdom (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

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
    expect(screen.getByText('1 of 1 matching tests shown · 3 tests in total')).toBeInTheDocument()
    await waitFor(() => expect(query().test_filter).toEqual(['b']))
  })

  it('says when no test matches the filter', async () => {
    mockWorld()
    renderPage(`${COMPARED}&test_filter=zzz`)

    expect(await screen.findByText('No tests match the filter.')).toBeInTheDocument()
  })

  it("keeps the checkboxes and the tests' names in view only while the columns do not fit", async () => {
    // Content far wider than the box, as `fakeLayout` lays every element out.
    fakeLayout()
    mockWorld()
    renderPage(COMPARED)
    const box = (await table('Comparison')).parentElement!
    expect(box).toHaveClass('overflowing')

    vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockReturnValue(800)
    act(() => resize())
    expect(box).not.toHaveClass('overflowing')
  })
})

describe('hidden tests (CP2)', () => {
  it('hides a test from the comparison, but not from the table', async () => {
    mockWorld(NOISY)
    renderPage(COMPARED)
    await comparison()
    const user = userEvent.setup()

    await user.click(showBox('d'))

    expect(await listedTests()).toEqual(['d', 'a', 'b', 'c'])
    // Greyed out.
    expect(showBox('d').closest('tr')).toHaveClass('hiddenRow')
    expect(showBox('a').closest('tr')).not.toHaveClass('hiddenRow')
    expect(screen.getByText('3 of 4 tests shown')).toBeInTheDocument()
    await waitFor(() => expect(query().hidden_test).toEqual(['d']))
    // The geomean is a's alone.
    expect((await comparison())[0]).toBe(
      'Geomean | 100 | 100.5 | 0.5 | +0.50% | 1.0050 | Regressed',
    )
  })

  it('hides a test with a click on its row, and leaves it hidden whatever the filters', async () => {
    mockWorld(NOISY)
    // a changes by less than 1%.
    renderPage(`${COMPARED}&min_delta_pct=1`)
    await comparison()
    const user = userEvent.setup()

    await user.click(screen.getByRole('cell', { name: 'd' }))
    expect(showBox('d')).not.toBeChecked()
    search('Filter tests', 'b')
    await waitFor(async () => expect(await listedTests()).toEqual(['b']))
    search('Filter tests', '')
    await waitFor(async () => expect(await listedTests()).toEqual(['d', 'b', 'c']))
    const hide = screen.getByRole('checkbox', { name: 'Hide inconclusive' })
    await user.click(hide)
    await waitFor(async () => expect(await listedTests()).toEqual(['b', 'c']))
    await user.click(hide)
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
    expect(screen.getByText('0 of 1 matching tests shown · 4 tests in total')).toBeInTheDocument()
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

  it('never changes a test the filter hides on a double-click', async () => {
    mockWorld(NOISY)
    // c is hidden and d is not, and the filter hides both.
    renderPage(`${COMPARED}&test_filter=^[ab]$&test_filter_regex=true&hidden_test=c`)
    await comparison()
    const user = userEvent.setup()

    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['b', 'c']))
    await user.dblClick(screen.getByRole('cell', { name: 'a' }))
    await waitFor(() => expect(query().hidden_test).toEqual(['c']))
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

    // Run 2 first: run 1 alone still has b, which run 2 alone would not, and forget.
    await user.click(runBox('2', 'A'))
    await user.click(runBox('1', 'A'))
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

    const why = await screen.findByText('too many hidden to reflect in the URL')
    const summary = why.parentElement
    expect(summary).toHaveTextContent(
      /^0 of 12 tests shown · too many hidden to reflect in the URL$/,
    )
    expect(why).toHaveAccessibleDescription('The URL holds at most 10 hidden tests.')
    expect(query().hidden_test).toBeUndefined()

    // The note follows the filter's total.
    search('Filter tests', 't1')
    await waitFor(() =>
      expect(summary).toHaveTextContent(
        /^0 of 3 matching tests shown · 12 tests in total · too many hidden to reflect in the URL$/,
      ),
    )
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

  it('says what the statistics are computed over in the menu, not on their headers', async () => {
    mockWorld(NOISY)
    renderPage(`${COMPARED}&columns=samples&columns=pvalue`)
    await comparison()

    for (const header of within(await table('Comparison')).getAllByRole('columnheader')) {
      expect(header.querySelector('[title]')).toBeNull()
    }

    // The line labels the group of the menu's items.
    await userEvent.setup().click(screen.getByRole('button', { name: 'Columns' }))
    expect(
      within(screen.getByRole('menu')).getByRole('group', {
        name: STATISTICS_OVER,
      }),
    ).toBeInTheDocument()
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
      'd | 2 | 3 | 1 | +50.00% | 1.5000 | 2 | 1 | 2 | 3 | N/A | Inconclusive',
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

  it("shows each test's CI and p-value, from its runs' values, N/A without an interval", async () => {
    mockWorld({
      ...CLASSIFIED,
      samples: {
        ...CLASSIFIED.samples,
        '1': [...CLASSIFIED.samples!['1'], ['exact', 2]],
        '2': [...CLASSIFIED.samples!['2'], ['exact', 2]],
        '3': [...CLASSIFIED.samples!['3'], ['exact', 3]],
        '5': [...CLASSIFIED.samples!['5'], ['exact', 3]],
      },
    })
    renderPage(`${COMPARED}&columns=ci&columns=pvalue&confidence=95`)

    const rows = await comparison()
    const cells = (test: string) =>
      rows
        .find((row) => row.startsWith(`${test} |`))
        ?.split(' | ')
        .slice(-3, -1)
    expect(headersOf(await table('Comparison')).slice(-3)).toEqual(['95% CI', 'P-value', 'Status'])
    // Without variance, the interval is the change itself, whose p-value is 0.
    expect(cells('exact')).toEqual(['+50.00% [+50.00%, +50.00%]', '0'])
    // The estimate is the ratio of the geometric means of the runs' values: 0.5 for down.
    expect(cells('down')?.[0]).toMatch(/^-50\.00% \[-\d+\.\d\d%, -\d+\.\d\d%\]$/)
    expect(Number(cells('up')?.[1])).toBeLessThan(0.01)
    expect(cells('one')).toEqual(['N/A', 'N/A'])
    expect(cells('neg')).toEqual(['N/A', 'N/A'])
    expect(cells('only')).toEqual(['N/A', 'N/A'])
    // Empty on the geomean.
    expect(rows[0].split(' | ').slice(-3, -1)).toEqual(['', ''])
  })

  it('shows an interval too wide to represent as infinite', async () => {
    mockWorld({
      runs: CLASSIFIED.runs,
      samples: { '1': [['t', 1]], '2': [['t', 1]], '3': [['t', 1e-300]], '5': [['t', 1e300]] },
    })
    renderPage(`${COMPARED}&columns=ci&confidence=99`)

    const row = (await comparison()).find((entry) => entry.startsWith('t |'))
    expect(row?.split(' | ').at(-2)).toBe('0.00% [-100.00%, +∞%]')
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
    expect(lines).toEqual(['d,2,3,1,50,1.5,2,1,Inconclusive'])
  })
})

describe('Copy as CSV (CP2)', () => {
  it('copies the CI as its estimate and bounds, the confidence in their headers', async () => {
    const writeText = mockClipboard()
    mockWorld(CLASSIFIED)
    renderPage(`${COMPARED}&columns=ci&test_filter=^(up|one)$&test_filter_regex=true`)
    await comparison()

    fireEvent.click(screen.getByRole('button', { name: 'Copy as CSV' }))

    await waitFor(() => expect(writeText).toHaveBeenCalled())
    const [header, geomean, ...lines] = writeText.mock.calls[0][0].split('\r\n')
    expect(header).toBe(
      'Test,Value A,Value B,Delta,Delta %,Ratio,CI estimate %,90% CI low %,90% CI high %,Status',
    )
    expect(geomean).toMatch(/,,,,Regressed$/)
    const [up, one] = lines.map((line) => line.split(','))
    expect(up.slice(6, 9).map(Number)).toEqual([
      expect.closeTo(49.51, 2),
      expect.closeTo(43.86, 2),
      expect.closeTo(55.38, 2),
    ])
    expect(one.slice(6)).toEqual(['', '', '', 'Inconclusive'])
  })

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
      'd,2,3,1,50,1.5,Inconclusive',
      'a,100,100.5,0.5,0.5,1.005,Inconclusive',
      'c,,5,,,,',
    ])
  })
})

describe('the Profile column (CP2)', () => {
  /**
   * The runs of COMPARED with profiles, by hex: those of side A (1, 2), and side B's (3). Only a
   * has a profile on both sides.
   */
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

  /** The commit of each run of COMPARED, by hex: side A's runs are at c1, and side B's at c2. */
  const COMMITS: Record<string, string> = { '1': 'c1', '2': 'c1', '3': 'c2' }

  /**
   * The Profiles page's URL for `test`, with side A in the run `a` and side B in the run `b`, by
   * the hex of their UUIDs. Side B is left on its default test, side A's (PF1).
   */
  function profilesUrl(test: string, a: string, b: string) {
    const side = (letter: string, hex: string) => [
      [`project_${letter}`, 'llvm'],
      [`suite_${letter}`, 'libcxx'],
      [`machine_${letter}`, 'm1'],
      [`commit_${letter}`, COMMITS[hex]],
      [`run_${letter}`, uuidOf(hex)],
    ]
    return `/profiles?${new URLSearchParams([...side('a', a), ['test_a', test], ...side('b', b)])}`
  }

  /**
   * A `profilesAnswer` answering as `answer` does, recording in `seen` the hex of each run it
   * answers, and a way to wait until it has answered some runs and the page has had the time to use
   * their profiles: a link missing before that would prove nothing.
   */
  function recorded(answer: (hex: string) => Response | undefined = () => undefined) {
    const seen: string[] = []
    return {
      profilesAnswer: (hex: string) => {
        seen.push(hex)
        return answer(hex)
      },
      async answered(...hexes: string[]) {
        await waitFor(() => expect(seen).toEqual(expect.arrayContaining(hexes)))
        await settle()
      },
    }
  }

  it("links each test profiled on both sides to the latest selected run's profile on each", async () => {
    mockWorld({ profiles: PROFILES })
    renderPage(COMPARED)

    // b has a profile on side A only, and c on side B only: neither has a link.
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({ a: profilesUrl('a', '2', '3') }),
    )
    expect(screen.getByRole('columnheader', { name: 'Profile' })).toBeInTheDocument()
  })

  it('follows the runs selected', async () => {
    mockWorld({ profiles: PROFILES })
    renderPage(COMPARED)
    await waitFor(async () => expect(Object.keys(await profileLinks())).toHaveLength(1))

    await userEvent.setup().click(runBox('2', 'A'))
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({ a: profilesUrl('a', '1', '3') }),
    )
  })

  it('is not shown when no test of the comparison has a profile on both sides', async () => {
    const { profilesAnswer, answered } = recorded()
    // Only elsewhere, which is not in the comparison, has a profile on both sides.
    mockWorld({ profiles: { '1': ['b', 'elsewhere'], '3': ['c', 'elsewhere'] }, profilesAnswer })
    renderPage(COMPARED)

    expect(await comparison()).toEqual(ROWS)
    await answered('1', '3')
    expect(screen.queryByRole('columnheader', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('says when profiles could not be listed, linking none', async () => {
    let fail = true
    const { profilesAnswer, answered } = recorded((hex) =>
      hex === '3' && fail ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    )
    mockWorld({ profiles: PROFILES, profilesAnswer })
    renderPage(COMPARED)

    expect(
      await screen.findByText(/The profiles could not be listed: Boom/),
    ).toBeInTheDocument()
    // Side A's profiles are listed, but they link nothing without side B's.
    await answered('1', '2')
    expect(screen.queryByRole('columnheader', { name: 'Profile' })).not.toBeInTheDocument()

    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({ a: profilesUrl('a', '2', '3') }),
    )
    expect(screen.queryByText(/could not be listed/)).not.toBeInTheDocument()
  })

  it("links none until all selected runs' profiles are listed on both sides", async () => {
    const { profilesAnswer, answered } = recorded((hex) =>
      hex === '2' ? errorResponse(500, 'internal_error', 'Boom') : undefined,
    )
    mockWorld({ profiles: PROFILES, profilesAnswer })
    renderPage(COMPARED)

    // Side A's run 1 has a profile of a, as side B's run 3 does, but side A's latest run is not
    // listed: linking run 1's would lead to the profile of an older run.
    expect(await screen.findByText(/The profiles could not be listed/)).toBeInTheDocument()
    await answered('1', '3')
    expect(screen.queryByRole('columnheader', { name: 'Profile' })).not.toBeInTheDocument()
  })

  it('says when the runs with profiles could not be listed, still comparing', async () => {
    let fail = true
    mockWorld({
      profiles: PROFILES,
      runsAnswer: (query) =>
        query.has('has_profiles') && fail
          ? errorResponse(500, 'internal_error', 'Boom')
          : undefined,
    })
    renderPage(COMPARED)

    expect(
      await screen.findByText(/The profiles could not be listed: Boom/),
    ).toBeInTheDocument()
    expect(await comparison()).toEqual(ROWS)

    fail = false
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(async () => expect(Object.keys(await profileLinks())).toHaveLength(1))
  })

  it('swaps the links with the sides', async () => {
    mockWorld({ profiles: PROFILES })
    renderPage(COMPARED)
    await waitFor(async () => expect(Object.keys(await profileLinks())).toHaveLength(1))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Swap sides' }))
    await waitFor(async () =>
      expect(await profileLinks()).toEqual({ a: profilesUrl('a', '3', '2') }),
    )
  })

  it('is shown whatever the filter, while a test of the comparison has a link', async () => {
    mockWorld({ profiles: { '1': ['a'], '3': ['a'] } })
    renderPage(`${COMPARED}&test_filter=c`)

    expect(await screen.findByRole('columnheader', { name: 'Profile' })).toBeInTheDocument()
    expect(await profileLinks()).toEqual({})
  })

  it('reports nothing for a machine that does not exist, before it is dropped', async () => {
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let profiled = false
    mockWorld({
      runsAnswer: (query) => {
        if (query.get('machine') !== 'bogus') return undefined
        if (query.has('has_profiles')) profiled = true
        return errorResponse(404, 'not_found', 'No such machine')
      },
    })
    // Hold the machines back, so that the page cannot know yet that the machine does not exist.
    server.use(
      mockApi('get', '/api/projects/{project}/suites/{suite}/machines', async () => {
        await held
      }),
    )
    renderPage('/compare?project_a=llvm&suite_a=libcxx&machine_a=bogus&commit_a=c1')

    await waitFor(() => expect(profiled).toBe(true))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(screen.queryByText(/could not be (listed|looked up)/)).not.toBeInTheDocument()
    release()
    await waitFor(() => expect(query().machine_a).toBeUndefined())
  })
})
