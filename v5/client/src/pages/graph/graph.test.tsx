import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { PlotData } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { colorOfName } from '../../chart-colors'
import { cursorPage, machine } from '../../test/fixtures'
import { errorResponse, mockApi, mockSeries, ndjsonResponse } from '../../test/mock-api'
import {
  currentUrl,
  gate,
  main,
  mockCommits,
  mockMachines,
  mockTests,
  query,
  renderPage,
  search,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'
import {
  COMMITS,
  GRAPHED,
  TESTS,
  addMachine,
  box,
  chart,
  commitAt,
  drawn,
  layout,
  listed,
  mockWorld,
  pointOf,
  testPage,
  testTable,
  answerSeries,
  traces,
  type Recorded,
  type Sample,
} from './graph-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** The samples of test a on m1, c10's then c20's, as `GET /series` serves them. */
const OF_A = [pointOf('m1', 'a', ['c10', 'r1', 1]), pointOf('m1', 'a', ['c20', 'r2', 2])]

/**
 * Answer each request to `GET /series` with `answer`, given how many were sent before it, and
 * record its signal.
 */
function mockAnswers(answer: (sent: number) => Response) {
  const signals: AbortSignal[] = []
  server.use(
    mockSeries(({ request }) => {
      signals.push(request.signal)
      return answer(signals.length - 1)
    }),
  )
  return signals
}

/** Answer `GET /series` with no line, the body of each response held until `held` opens. */
function mockHeld(recorded: Recorded, held: { promise: Promise<void> }) {
  answerSeries(recorded, () => ndjsonResponse([], { wait: () => held.promise }))
}

describe('the Graph page (GR1)', () => {
  it('disables every control until a suite is selected, with nothing to plot', async () => {
    mockWorld()
    renderPage('/graph')

    expect(await main().findByText('Select a suite first.')).toBeInTheDocument()
    expect(selectButton('Suite')).toHaveTextContent('-- Select suite --')
    expect(screen.getByRole('combobox', { name: 'Machines' })).toBeDisabled()
    expect(selectButton('Metric')).toBeDisabled()
    expect(screen.getByRole('searchbox', { name: 'Filter tests' })).toBeDisabled()
    // GR12: the overlay, with no axis to keep.
    expect(layout().annotations?.[0]?.text).toBe('No data to plot')
  })

  it('offers only the numeric metrics of the suite selected', async () => {
    mockWorld()
    renderPage('/graph')

    await pickOption('Suite', 'libcxx')
    expect(currentUrl()).toBe('/graph?suite=libcxx')
    expect(selectButton('Metric')).toHaveTextContent('-- Select metric --')
    await userEvent.setup().click(selectButton('Metric'))
    const options = screen.getAllByRole('option').map((option) => option.textContent)
    expect(options).toEqual(['Execution Time', 'Compile Time'])
  })

  it('says so when the suite has no numeric metric', async () => {
    mockWorld()
    renderPage('/graph?suite=text_only')

    expect(await main().findByText('This suite has no numeric metric.')).toBeInTheDocument()
  })

  it('adds machines as chips showing their marker, and offers each once', async () => {
    mockWorld()
    renderPage('/graph?suite=libcxx')

    await addMachine('m2')
    await addMachine('m1')

    expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m2&machine=m1')
    const chips = within(screen.getByRole('list', { name: 'Machines added' }))
      .getAllByRole('listitem')
    expect(chips.map((chip) => chip.textContent)).toEqual(['●m2×', '▲m1×'])
    await userEvent.setup().type(screen.getByRole('combobox', { name: 'Machines' }), 'm')
    // Both are added: the list has nothing left to offer.
    expect(await screen.findByText('No matches.')).toBeInTheDocument()
    await userEvent.setup().keyboard('{Escape}')

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m2' }))
    expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m1')
    // The focus goes to the chip left, then to the combobox once none is.
    expect(screen.getByRole('button', { name: 'Remove m1' })).toHaveFocus()
    await userEvent.setup().keyboard('{Enter}')
    expect(screen.getByRole('combobox', { name: 'Machines' })).toHaveFocus()
  })

  it('offers the untracked machines last, under their heading, until they are added (AR18)', async () => {
    mockWorld()
    mockMachines(() => ({
      items: [machine('m0', { tracked: false }), machine('m1'), machine('m2')],
    }))
    renderPage('/graph?suite=libcxx')
    const user = userEvent.setup()
    const combobox = await screen.findByRole('combobox', { name: 'Machines' })
    await waitFor(() => expect(combobox).toBeEnabled())

    await user.type(combobox, 'm')
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'm1',
        'm2',
        'm0',
      ]),
    )
    expect(
      within(screen.getByRole('group', { name: 'Untracked' })).getByRole('option'),
    ).toHaveTextContent('m0')
    await user.keyboard('{Escape}')

    await addMachine('m0')
    await user.type(combobox, 'm')
    await waitFor(() =>
      expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
        'm1',
        'm2',
      ]),
    )
    expect(screen.queryByRole('group', { name: 'Untracked' })).toBeNull()
  })

  it('says nothing is missing while the suite and machines of its URL are checked', async () => {
    const suites = gate()
    mockWorld({ suitesWait: () => suites.promise })
    renderPage(`${GRAPHED}&test=a`)

    expect(await main().findByText('Loading...')).toBeInTheDocument()
    expect(layout().annotations).toEqual([])
    act(() => suites.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
  })

  it('shows the highlighted commit by its display value once it is on the x-axis', async () => {
    const commits = gate()
    mockWorld()
    mockCommits(async (query) => {
      await commits.promise
      return cursorPage(COMMITS[query.get('machine') as 'm1' | 'm2'].map(commitAt))
    })
    renderPage(`${GRAPHED}&highlight=c20`)
    const chip = () => main().getByRole('list', { name: 'Highlighted commits' })

    // The commit string, until the x-axis gives its display value.
    await waitFor(() => expect(chip()).toHaveTextContent(/^Highlighted: c20×$/))
    act(() => commits.open())
    await waitFor(() => expect(chip()).toHaveTextContent(/^Highlighted: r20×$/))
  })

  it('says there is nothing to plot once the tests selected have no data', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=c`)

    await waitFor(() => expect(layout().annotations?.[0]?.text).toBe('No data to plot'))
    const name = 'Execution Time over time: no data to plot'
    expect(main().getByRole('img')).toHaveAccessibleName(name)
  })

  it("lists every test the machines have for the metric, and plots none of them", async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)

    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c', 'd']))
    expect(main().getByText('0 of 4 tests selected')).toHaveAttribute('role', 'status')
    expect(recorded.series).toEqual([])
    expect(traces()).toEqual([])
  })

  it('plots a test selected on each machine whose list holds it, and asks only it', async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c', 'd']))

    fireEvent.click(box('a'))

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    // m2 has no test a: it is not asked about it, which the API would refuse (E9). Only the
    // commits with an ordinal, the only ones the x-axis places (GR3).
    expect(recorded.series.map(({ query }) => query.toString())).toEqual([
      'metric=execution_time&machine=m1&test=a&has_ordinal=true',
    ])
    expect(currentUrl()).toBe(`${GRAPHED}&test=a`)
  })

  it('gives a test a colour by its name, and a machine its marker', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=b`)

    await waitFor(() => expect(traces()).toEqual(['b - m1: c10=3', 'b - m2: c40=4']))
    const data = chart().data as PlotData[]
    expect(data.map((trace) => trace.line.color)).toEqual([colorOfName('b'), colorOfName('b')])
    expect(data.map((trace) => trace.marker.symbol)).toEqual(['circle', 'triangle-up'])
  })

  it("puts every machine's commits on the x-axis, by display value and ordinal (GR3)", async () => {
    mockWorld()
    renderPage(GRAPHED)

    await waitFor(() => expect(layout().xaxis?.categoryarray).toEqual(['c10', 'c20', 'c30', 'c40']))
    const xaxis = layout().xaxis!
    expect(xaxis.type).toBe('category')
    expect(xaxis.labelalias).toEqual({ c10: 'r10', c20: 'r20', c30: 'r30', c40: 'r40' })
    expect(xaxis.range).toEqual([-0.5, 3.5])
    expect(xaxis.autorange).toBe(false)
    expect(layout().showlegend).toBe(false)
  })

  it("resets the zoom when the x-axis changes, and only then (GR5)", async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=b`)
    await waitFor(() => expect(traces()).toHaveLength(2))
    const revision = layout().uirevision

    fireEvent.click(box('c'))
    await waitFor(() => expect(main().getByText('2 of 4 tests selected')).toBeInTheDocument())
    expect(layout().uirevision).toBe(revision)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m2' }))
    await waitFor(() => expect(layout().uirevision).not.toBe(revision))
  })
})

describe('the aggregation (GR1)', () => {
  const SPREAD: Record<string, Sample[]> = {
    // At c10: run r1 measured 1 and 5, run r2 measured 10.
    'm1/a': [
      ['c10', 'r1', 1],
      ['c10', 'r1', 5],
      ['c10', 'r2', 10],
    ],
  }

  it("combines each run's samples, then the runs at a commit, median by default", async () => {
    mockWorld({ samples: SPREAD })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    // Run r1's median is 3: the median of 3 and 10 is 6.5.
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=6.5']))
  })

  it('applies the aggregations chosen, without asking for the data again', async () => {
    const recorded = mockWorld({ samples: SPREAD })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')
    await waitFor(() => expect(traces()).toHaveLength(1))

    await pickOption('Sample aggregation', 'max')
    await pickOption('Run aggregation', 'min')

    expect(traces()).toEqual(['a - m1: c10=5'])
    expect(currentUrl()).toContain('sample_agg=max&run_agg=min')
    expect(recorded.series).toHaveLength(1)
  })
})

/** How the selection's count goes on with GRAPHED's tests, filtered. */
const MATCHING = 'matching tests selected · 4 tests in total'

describe('the selection (GR6, GR7, GR14)', () => {
  it('toggles a test with a click on its row, once with its checkbox', async () => {
    mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toHaveLength(4))

    fireEvent.click(testTable().getByText('b'))
    expect(box('b')).toBeChecked()
    fireEvent.click(box('b'))
    expect(box('b')).not.toBeChecked()
  })

  it('selects a range of rows with Shift held (AR10)', async () => {
    mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toHaveLength(4))

    const user = userEvent.setup()
    await user.click(testTable().getByText('a'))
    await user.keyboard('{Shift>}')
    await user.click(testTable().getByText('c'))
    await user.keyboard('{/Shift}')

    expect(currentUrl()).toBe(`${GRAPHED}&test=a&test=b&test=c`)
  })

  it('isolates a test on a double-click, and selects every test back on another', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(box('a')).toBeChecked())

    const user = userEvent.setup()
    await user.dblClick(testTable().getByText('c'))
    expect(currentUrl()).toBe(`${GRAPHED}&test=c`)
    await user.dblClick(testTable().getByText('c'))
    expect(currentUrl()).toBe(`${GRAPHED}&test=a&test=b&test=c&test=d`)
  })

  it('keeps at most 10 tests in the URL, and says so once the selection is not in it', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `t${String(i).padStart(2, '0')}`)
    mockWorld({ tests: { m1: names } })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(11))

    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))

    expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m1&metric=execution_time')
    // Followed by " · loading..." while the tests' data loads.
    const count = main().getByText(/^11 of 11 tests selected/)
    expect(count).toHaveTextContent(/^11 of 11 tests selected · too many to reflect in the URL/)
    expect(within(count).getByText(/too many/)).toHaveAccessibleDescription(
      'The URL reflects a selection of at most 10 tests.',
    )
    fireEvent.click(box('t00'))
    expect(currentUrl()).toContain('&test=t01&test=t02')
    expect(count).not.toHaveTextContent(/too many/)
  })

  it('says the URL lacks the selection, and how many selected tests the filter hides', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `t${String(i).padStart(2, '0')}`)
    mockWorld({ tests: { m1: names } })
    const tests = names.map((name) => `test=${name}`).join('&')
    renderPage(`/graph?suite=libcxx&machine=m1&metric=execution_time&test_filter=t0&${tests}`)
    await waitFor(() => expect(listed()).toHaveLength(10))

    expect(main().getByText(/^10 of 10 matching tests selected/)).toHaveTextContent(
      '10 of 10 matching tests selected · 11 tests in total · 1 more hidden by the filter · ' +
        'too many to reflect in the URL',
    )
  })

  describe('selects at most 100 tests', () => {
    const NAMES = Array.from({ length: 101 }, (_, i) => `t${String(i).padStart(3, '0')}`)
    const ONE_MACHINE = '/graph?suite=libcxx&machine=m1&metric=execution_time'
    const WHY = 'At most 100 tests can be selected at once.'

    it('and says why it cannot select them all', async () => {
      mockWorld({ tests: { m1: NAMES } })
      renderPage(ONE_MACHINE)
      await waitFor(() => expect(listed()).toHaveLength(101))

      const all = testTable().getByRole('checkbox', { name: 'Select all tests shown' })
      expect(all).toBeDisabled()
      expect(all).toHaveAccessibleDescription(WHY)
    })

    it('of a URL naming more, the first 100, and then no other', async () => {
      mockWorld({ tests: { m1: NAMES } })
      renderPage(`${ONE_MACHINE}&${NAMES.map((name) => `test=${name}`).join('&')}`)
      await waitFor(() => expect(listed()).toHaveLength(101))

      expect(box('t099')).toBeChecked()
      expect(box('t100')).not.toBeChecked()
      expect(box('t100')).toBeDisabled()
      expect(box('t100')).toHaveAccessibleDescription(WHY)
    })

    it('counting those the filter hides', async () => {
      mockWorld({ tests: { m1: NAMES } })
      const first = NAMES.slice(0, 100).map((name) => `test=${name}`)
      renderPage(`${ONE_MACHINE}&test_filter=t100&${first.join('&')}`)
      await waitFor(() => expect(listed()).toEqual(['t100']))

      const count = main().getByText(/^0 of 1 matching tests selected/)
      expect(count).toHaveTextContent(
        '0 of 1 matching tests selected · 101 tests in total · 100 more hidden by the filter · ' +
          'too many to reflect in the URL',
      )
      expect(box('t100')).toBeDisabled()
      expect(box('t100')).toHaveAccessibleDescription(WHY)
      const all = testTable().getByRole('checkbox', { name: 'Select all tests shown' })
      expect(all).toBeDisabled()
      // Neither does isolating t100, which would select 101 tests.
      await userEvent.setup().dblClick(testTable().getByText('t100'))
      expect(box('t100')).not.toBeChecked()
    })

    it('not even by double-clicking the only test selected', async () => {
      mockWorld({ tests: { m1: NAMES } })
      renderPage(`${ONE_MACHINE}&test=t005`)
      await waitFor(() => expect(box('t005')).toBeChecked())

      await userEvent.setup().dblClick(testTable().getByText('t005'))

      expect(currentUrl()).toBe(`${ONE_MACHINE}&test=t005`)
    })
  })

  it('clears the selection with the last machine', async () => {
    mockWorld()
    renderPage(`/graph?suite=libcxx&machine=m1&metric=execution_time&test=a`)
    await waitFor(() => expect(box('a')).toBeChecked())

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m1' }))

    await waitFor(() => expect(currentUrl()).toBe('/graph?suite=libcxx&metric=execution_time'))
  })

  it('keeps the tests of the URL that its filter hides, and plots them (GR14)', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test_filter=b&test=a&test=b`)

    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'b - m1', 'b - m2']))
    expect(listed()).toEqual(['b'])
    expect(query()).toMatchObject({ test: ['a', 'b'] })
    expect(
      await main().findByText(`1 of 1 ${MATCHING} · 1 more hidden by the filter`),
    ).toBeVisible()
  })

  it('keeps a long selection of the URL there until what it names is known', async () => {
    const lists = gate()
    mockWorld()
    mockTests(async (query) => {
      await lists.promise
      return testPage(TESTS[query.get('machine') as 'm1'])
    })
    const unknown = Array.from({ length: 11 }, (_, i) => `test=gone${i}`).join('&')
    renderPage(`${GRAPHED}&test=a&${unknown}`)
    await screen.findByText('Loading tests...')

    expect(query().test).toHaveLength(12)
    act(() => lists.open())
    await waitFor(() => expect(query().test).toEqual(['a']))
  })

  it('counts among the tests the filter hides only those listed', async () => {
    const lists = gate()
    mockWorld()
    // m2's tests, held: zzz, which no list holds so far, stays selected meanwhile.
    mockTests(async (query) => {
      const machine = query.get('machine') as 'm1' | 'm2'
      if (machine === 'm2') await lists.promise
      return testPage(TESTS[machine])
    })
    renderPage(`${GRAPHED}&test_filter=b&test=a&test=zzz`)

    const counted =
      '0 of 1 matching tests selected · 3 tests in total · 1 more hidden by the filter'
    expect(await main().findByText(counted)).toBeVisible()
    expect(query().test).toEqual(['a', 'zzz'])
    act(() => lists.open())
    expect(
      await main().findByText(`0 of 1 ${MATCHING} · 1 more hidden by the filter`),
    ).toBeVisible()
    await waitFor(() => expect(query().test).toEqual(['a']))
  })

  it('keeps the tests the filter hides selected and drawn, in either mode', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'b - m1', 'b - m2']))

    search('Filter tests', 'b')
    await waitFor(() => expect(listed()).toEqual(['b']))
    expect(main().getByText(`1 of 1 ${MATCHING} · 1 more hidden by the filter`)).toBeVisible()
    await waitFor(() => expect(query()).toMatchObject({ test_filter: ['b'], test: ['a', 'b'] }))
    expect(drawn()).toEqual(['a - m1', 'b - m1', 'b - m2'])

    fireEvent.click(screen.getByRole('checkbox', { name: 'Regex' }))
    search('Filter tests', '^[bc]$')
    await waitFor(() => expect(listed()).toEqual(['b', 'c']))
    await waitFor(() =>
      expect(query()).toMatchObject({
        test_filter: ['^[bc]$'],
        test_filter_regex: ['true'],
        test: ['a', 'b'],
      }),
    )

    // The rows the filter hid come back as they were.
    search('Filter tests', '')
    await waitFor(() => expect(listed()).toHaveLength(4))
    expect(box('a')).toBeChecked()
    expect(main().getByText('2 of 4 tests selected')).toBeInTheDocument()
  })

  it('selects or deselects only the rows shown from the header, as its state says', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test_filter=^[bc]$&test_filter_regex=true`)
    await waitFor(() => expect(listed()).toEqual(['b', 'c']))
    const all = testTable().getByRole('checkbox', { name: 'Select all tests shown' })

    // a, which the filter hides, is selected, but none of the rows shown is.
    expect(all).not.toBeChecked()
    expect(all).not.toBePartiallyChecked()
    fireEvent.click(all)
    expect(all).toBeChecked()
    await waitFor(() => expect(query().test).toEqual(['a', 'b', 'c']))

    fireEvent.click(box('b'))
    expect(all).toBePartiallyChecked()
    fireEvent.click(all)
    fireEvent.click(all)
    await waitFor(() => expect(query().test).toEqual(['a']))
    expect(all).not.toBeChecked()
  })

  it('isolates a test among the rows shown on a double-click, leaving those hidden', async () => {
    mockWorld()
    // a is selected and d is not, and the filter hides both.
    renderPage(`${GRAPHED}&test=a&test=b&test_filter=^[bc]$&test_filter_regex=true`)
    await waitFor(() => expect(box('b')).toBeChecked())

    const user = userEvent.setup()
    await user.dblClick(testTable().getByText('c'))
    await waitFor(() => expect(query().test).toEqual(['a', 'c']))
    await user.dblClick(testTable().getByText('c'))
    await waitFor(() => expect(query().test).toEqual(['a', 'b', 'c']))
  })

  it('drops a test of the URL that no machine lists, once every list is in (GR14)', async () => {
    const recorded = mockWorld()
    renderPage(`${GRAPHED}&test=b&test=zzz`)

    await waitFor(() => expect(currentUrl()).toBe(`${GRAPHED}&test=b`))
    expect(recorded.series.flatMap(({ query }) => query.getAll('test'))).not.toContain('zzz')
  })

  it('keeps the selection as the metric changes, then drops what the new lists lack', async () => {
    const lists = gate()
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(box('a')).toBeChecked())
    // compile_time's lists, held: a stays selected meanwhile.
    mockTests(async (query) => {
      await lists.promise
      return testPage(query.get('machine') === 'm1' ? ['b'] : ['b', 'd'])
    })

    await pickOption('Metric', 'Compile Time')
    expect(currentUrl()).toContain('test=a&test=b')
    act(() => lists.open())

    await waitFor(() => expect(query()).toMatchObject({ metric: ['compile_time'], test: ['b'] }))
  })

  it('clears the machines, metric, tests and highlight on a new suite, not the rest', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test_filter=a&sample_agg=max&highlight=c20`)
    await waitFor(() => expect(box('a')).toBeChecked())

    await pickOption('Suite', 'text_only')

    await waitFor(() =>
      expect(query()).toEqual({ suite: ['text_only'], test_filter: ['a'], sample_agg: ['max'] }),
    )
  })

  it('starts afresh when navigated to, and takes up a selection gone back to', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(box('a')).toBeChecked())

    fireEvent.click(screen.getByRole('link', { name: 'Graph' }))
    await waitFor(() => expect(selectButton('Suite')).toHaveTextContent('-- Select suite --'))
    expect(currentUrl()).toBe('/graph')

    fireEvent.click(screen.getByRole('button', { name: 'Browser back' }))
    await waitFor(() => expect(box('a')).toBeChecked())
    expect(currentUrl()).toBe(`${GRAPHED}&test=a`)
  })
})

describe('loading (GR2, GR4, GR8)', () => {
  it('draws a test once all its data has arrived, saying it is loading meanwhile', async () => {
    const rest = gate()
    mockWorld()
    mockAnswers(() => ndjsonResponse([[OF_A[0]], [OF_A[1]]], { wait: () => rest.promise }))
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    expect(await main().findByText('1 of 3 tests selected · loading...')).toBeInTheDocument()
    expect(testTable().getByText('(loading...)')).toBeInTheDocument()
    expect(traces()).toEqual([])

    act(() => rest.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(main().getByText('1 of 3 tests selected')).toBeInTheDocument()
  })

  it('asks for each test selected on each machine whose list holds it, apart', async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toHaveLength(4))

    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))

    await waitFor(() => expect(recorded.series).toHaveLength(6))
    const asked = recorded.series.map(({ query }) => `${query.get('machine')}/${query.get('test')}`)
    expect(asked.sort()).toEqual(['m1/a', 'm1/b', 'm1/c', 'm2/b', 'm2/c', 'm2/d'])
  })

  it('sends at most 6 requests at once, and the others once those have all arrived', async () => {
    const held = gate()
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
    const recorded = mockWorld({ machines: ['m1'], tests: { m1: names } })
    // The responses start at once, and only their bodies are held.
    mockHeld(recorded, held)
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(8))

    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))

    await waitFor(() => expect(recorded.series).toHaveLength(6))
    act(() => held.open())
    await waitFor(() => expect(recorded.series).toHaveLength(8))
    await waitFor(() => expect(main().getByText('8 of 8 tests selected')).toBeInTheDocument())
  })

  it('sends the next request once a test whose data is arriving is deselected', async () => {
    const held = gate()
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7']
    const recorded = mockWorld({ machines: ['m1'], tests: { m1: names } })
    mockHeld(recorded, held)
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(7))
    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))
    await waitFor(() => expect(recorded.series).toHaveLength(6))

    // Its response's body never ends by itself, so only stopping reading it frees its slot.
    fireEvent.click(box('t1'))

    await waitFor(() => expect(recorded.series).toHaveLength(7))
    expect(recorded.series[6].query.getAll('test')).toEqual(['t7'])
    act(() => held.open())
  })

  it('asks for nothing again when a test is selected again', async () => {
    const recorded = mockWorld()
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(traces()).toHaveLength(1))

    fireEvent.click(box('a'))
    fireEvent.click(box('a'))

    await waitFor(() => expect(traces()).toHaveLength(1))
    expect(recorded.series).toHaveLength(1)
  })

  it("stops loading a machine's data once the machine is removed", async () => {
    const held = gate()
    const recorded = mockWorld()
    mockHeld(recorded, held)
    renderPage(`${GRAPHED}&test=b`)
    await waitFor(() => expect(recorded.series).toHaveLength(2))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m2' }))

    const m2 = recorded.series.find(({ query }) => query.get('machine') === 'm2')!
    await waitFor(() => expect(m2.signal.aborted).toBe(true))
    const m1 = recorded.series.find(({ query }) => query.get('machine') === 'm1')!
    expect(m1.signal.aborted).toBe(false)
    act(() => held.open())
  })

  it('lays out its x-axis from the commits of each machine that have an ordinal (GR3)', async () => {
    mockWorld()
    const asked = mockCommits((query) => {
      const machineName = query.get('machine') as 'm1' | 'm2'
      return cursorPage(COMMITS[machineName].map(commitAt))
    })
    renderPage(`${GRAPHED}&test=b`)

    await waitFor(() => expect(traces()).toEqual(['b - m1: c10=3', 'b - m2: c40=4']))
    const scaffolds = asked.map((query) => [
      query.get('machine'),
      query.get('sort'),
      query.get('has_ordinal'),
    ])
    expect(scaffolds.sort()).toEqual([
      ['m1', 'ordinal', 'true'],
      ['m2', 'ordinal', 'true'],
    ])
  })

  it("holds back a machine's traces until its commits are listed, saying why", async () => {
    mockWorld()
    let failing = true
    server.use(
      mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
        const machineName = new URL(request.url).searchParams.get('machine') as 'm1' | 'm2'
        if (machineName === 'm2' && failing) {
          return errorResponse(500, 'internal_error', 'The commits broke.')
        }
        return HttpResponse.json(cursorPage(COMMITS[machineName].map(commitAt)))
      }),
    )
    renderPage(`${GRAPHED}&test=b`)

    expect(
      await main().findByText(/The commits of m2 could not be listed: The commits broke\./),
    ).toBeInTheDocument()
    await waitFor(() => expect(traces()).toEqual(['b - m1: c10=3']))
    expect(layout().annotations).toEqual([])

    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(traces()).toEqual(['b - m1: c10=3', 'b - m2: c40=4']))
  })

  it('says a response cut short failed, and loads the test again, whole, on Retry', async () => {
    mockWorld()
    const sent = mockAnswers((before) =>
      before === 0 ? ndjsonResponse([[OF_A[0]]], { cut: true }) : ndjsonResponse([OF_A]),
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    expect(await main().findByText(/data of some tests could not be loaded/)).toBeInTheDocument()
    expect(traces()).toEqual([])
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(sent).toHaveLength(2)
  })

  it('loads a test deselected while loading again, whole, once reselected', async () => {
    mockWorld()
    const first = gate()
    const sent = mockAnswers((before) =>
      before === 0
        ? ndjsonResponse([[OF_A[0]], [OF_A[1]]], { wait: () => first.promise })
        : ndjsonResponse([OF_A]),
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')
    await waitFor(() => expect(sent).toHaveLength(1))

    fireEvent.click(box('a'))
    await waitFor(() => expect(sent[0].aborted).toBe(true))
    fireEvent.click(box('a'))

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(sent).toHaveLength(2)
    expect(main().getByText('1 of 3 tests selected')).toBeInTheDocument()
    act(() => first.open())
  })

  it('stops loading a test once it is deselected', async () => {
    const held = gate()
    const recorded = mockWorld()
    mockHeld(recorded, held)
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(recorded.series).toHaveLength(1))

    fireEvent.click(box('a'))

    await waitFor(() => expect(recorded.series[0].signal.aborted).toBe(true))
    act(() => held.open())
  })

  it('stops loading only the test deselected, not the others', async () => {
    const held = gate()
    const recorded = mockWorld()
    mockHeld(recorded, held)
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a&test=b')
    await waitFor(() => expect(recorded.series).toHaveLength(2))

    fireEvent.click(box('a'))

    const of = (test: string) => recorded.series.find(({ query }) => query.get('test') === test)!
    await waitFor(() => expect(of('a').signal.aborted).toBe(true))
    expect(of('b').signal.aborted).toBe(false)
    act(() => held.open())
  })

  it("says why the machines' tests could not be listed, and tries again", async () => {
    mockWorld()
    let failing = true
    server.use(
      mockApi('get', '/api/suites/{testsuite}/tests', ({ request }) => {
        const machineName = new URL(request.url).searchParams.get('machine') as 'm1' | 'm2'
        return failing && machineName === 'm2'
          ? errorResponse(500, 'internal_error', 'The tests broke.')
          : HttpResponse.json(testPage(TESTS[machineName]))
      }),
    )
    renderPage(GRAPHED)

    expect(
      await main().findByText(/The tests could not be listed: The tests broke\./),
    ).toBeInTheDocument()
    // Those of the other machine stay listed, and are not said to be loading (AR7).
    expect(listed()).toEqual(['a', 'b', 'c'])
    expect(main().queryByText('Loading tests...')).not.toBeInTheDocument()
    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c', 'd']))
  })

  it("says why the suite's machines could not be listed", async () => {
    mockWorld()
    server.use(
      mockApi('get', '/api/suites/{testsuite}/machines', () =>
        errorResponse(500, 'internal_error', 'The machines broke.'),
      ),
    )
    renderPage('/graph?suite=libcxx')

    expect(
      await main().findByText(/The machines could not be listed: The machines broke\./),
    ).toBeInTheDocument()
  })
})

describe('the URL (GR14, AR2)', () => {
  it('drops a suite that does not exist, and what was chosen in it', async () => {
    mockWorld()
    renderPage('/graph?suite=nope&machine=m1&metric=execution_time&test=a&highlight=c10')
    await waitFor(() => expect(currentUrl()).toBe('/graph'))
  })

  it('drops a machine that does not exist, and a metric that is not numeric', async () => {
    mockWorld()
    renderPage('/graph?suite=libcxx&machine=gone&machine=m1&metric=hash')
    await waitFor(() => expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m1'))
  })
})
