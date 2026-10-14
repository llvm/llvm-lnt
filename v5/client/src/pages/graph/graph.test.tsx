import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { PlotData } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import { colorOfName } from '../../chart-colors'
import { cursorPage } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { currentUrl, gate, main, mockTests, query, renderPage, search } from '../../test/page'
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
  traces,
  type Sample,
} from './graph-world'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/**
 * Answer `POST /query` for test a on m1 with two pages, c10 then c20, the second once `second`
 * says how, and record the cursor of each request.
 */
function mockTwoPages(second: () => Promise<Response | null> = async () => null) {
  const cursors: (string | null | undefined)[] = []
  server.use(
    mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
      const { cursor } = await request.json()
      cursors.push(cursor)
      if (cursor) {
        const answer = await second()
        if (answer !== null) return answer
      }
      const sample: Sample = cursor ? ['c20', 'r2', 2] : ['c10', 'r1', 1]
      return HttpResponse.json(cursorPage([pointOf('m1', 'a', sample)], cursor ? null : '1'))
    }),
  )
  return cursors
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

  it('says nothing is missing while the suite and machines of its URL are checked', async () => {
    const suites = gate()
    mockWorld({ suitesWait: () => suites.promise })
    renderPage(`${GRAPHED}&test=a`)

    expect(await main().findByText('Loading...')).toBeInTheDocument()
    expect(layout().annotations).toEqual([])
    act(() => suites.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
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
    expect(recorded.queries).toEqual([])
    expect(traces()).toEqual([])
  })

  it('plots a test selected on each machine whose list holds it, and asks only it', async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c', 'd']))

    fireEvent.click(box('a'))

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    // m2 has no test a: it is not asked about it, which the API would refuse (E9).
    expect(recorded.queries.map(({ body }) => [body.machine, body.test, body.sort])).toEqual([
      ['m1', ['a'], 'commit'],
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
    expect(recorded.queries).toHaveLength(1)
  })

  it('combines the samples of a commit that spans two pages as one', async () => {
    mockWorld({ samples: SPREAD, pageSize: 2 })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a&run_agg=max')

    // Run r1 spans both pages: its median is still 3, not one value per page.
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=10']))
    await pickOption('Run aggregation', 'min')
    expect(traces()).toEqual(['a - m1: c10=3'])
  })
})

/** How the selection's count goes on with GRAPHED's tests, filtered. */
const MATCHING = 'matching tests selected (4 total)'

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
    // Followed by ", loading..." while the tests' data loads.
    const count = main().getByText(/^11 of 11 tests selected/)
    expect(count).toHaveTextContent(/^11 of 11 tests selected \(too many to reflect in the URL\)/)
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
      '10 of 10 matching tests selected (11 total) (too many to reflect in the URL), ' +
        '1 more hidden by the filter',
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
        /^0 of 1 matching tests selected \(101 total\) .*, 100 more hidden by the filter/,
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
    expect(await main().findByText(`1 of 1 ${MATCHING}, 1 more hidden by the filter`)).toBeVisible()
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

    const counted = '0 of 1 matching tests selected (3 total), 1 more hidden by the filter'
    expect(await main().findByText(counted)).toBeVisible()
    expect(query().test).toEqual(['a', 'zzz'])
    act(() => lists.open())
    expect(await main().findByText(`0 of 1 ${MATCHING}, 1 more hidden by the filter`)).toBeVisible()
    await waitFor(() => expect(query().test).toEqual(['a']))
  })

  it('keeps the tests the filter hides selected and drawn, in either mode', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(drawn()).toEqual(['a - m1', 'b - m1', 'b - m2']))

    search('Filter tests', 'b')
    await waitFor(() => expect(listed()).toEqual(['b']))
    expect(main().getByText(`1 of 1 ${MATCHING}, 1 more hidden by the filter`)).toBeVisible()
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
    expect(recorded.queries.flatMap(({ body }) => body.test)).not.toContain('zzz')
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

  it('clears the machines, the metric and the tests on a new suite, keeping the rest', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test_filter=a&sample_agg=max`)
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
  it('draws the pages of a test as they arrive, saying that it is loading meanwhile', async () => {
    const second = gate()
    mockWorld()
    mockTwoPages(async () => {
      await second.promise
      return null
    })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1']))
    expect(main().getByText('1 of 3 tests selected, loading...')).toBeInTheDocument()
    expect(testTable().getByText('(loading...)')).toBeInTheDocument()

    act(() => second.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(main().getByText('1 of 3 tests selected')).toBeInTheDocument()
  })

  it('asks for each test selected on each machine whose list holds it, apart', async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toHaveLength(4))

    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))

    await waitFor(() => expect(recorded.queries).toHaveLength(6))
    const asked = recorded.queries.map(({ body }) => `${body.machine}/${body.test!.join()}`)
    expect(asked.sort()).toEqual(['m1/a', 'm1/b', 'm1/c', 'm2/b', 'm2/c', 'm2/d'])
  })

  it('sends at most 6 requests at once, and the others as those are answered', async () => {
    const held = gate()
    const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
    const recorded = mockWorld({ machines: ['m1'], tests: { m1: names } })
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        recorded.queries.push({ body: await request.json(), signal: request.signal })
        await held.promise
        return HttpResponse.json(cursorPage([]))
      }),
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(8))

    fireEvent.click(testTable().getByRole('checkbox', { name: 'Select all tests shown' }))

    await waitFor(() => expect(recorded.queries).toHaveLength(6))
    act(() => held.open())
    await waitFor(() => expect(recorded.queries).toHaveLength(8))
    await waitFor(() => expect(main().getByText('8 of 8 tests selected')).toBeInTheDocument())
  })

  it('asks for nothing again when a test is selected again', async () => {
    const recorded = mockWorld()
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(traces()).toHaveLength(1))

    fireEvent.click(box('a'))
    fireEvent.click(box('a'))

    await waitFor(() => expect(traces()).toHaveLength(1))
    expect(recorded.queries).toHaveLength(1)
  })

  it("stops loading a machine's data once the machine is removed", async () => {
    const held = gate()
    const recorded = mockWorld()
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        recorded.queries.push({ body: await request.json(), signal: request.signal })
        await held.promise
        return HttpResponse.json(cursorPage([]))
      }),
    )
    renderPage(`${GRAPHED}&test=b`)
    await waitFor(() => expect(recorded.queries).toHaveLength(2))

    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove m2' }))

    const m2 = recorded.queries.find(({ body }) => body.machine === 'm2')!
    await waitFor(() => expect(m2.signal.aborted).toBe(true))
    expect(recorded.queries.find(({ body }) => body.machine === 'm1')!.signal.aborted).toBe(false)
    act(() => held.open())
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

  it('starts a test over from its first page on Retry, adding no point twice', async () => {
    mockWorld()
    let failing = true
    const sent = mockTwoPages(async () =>
      failing ? errorResponse(500, 'internal_error', 'The page broke.') : null,
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    expect(await main().findByText(/data of some tests could not be loaded/)).toBeInTheDocument()
    expect(traces()).toEqual(['a - m1: c10=1'])
    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))

    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(sent).toEqual([null, '1', null, '1'])
  })

  it('starts a test over by itself after a refused cursor, showing what it had', async () => {
    mockWorld()
    const restart = gate()
    const sent: (string | null | undefined)[] = []
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        const { cursor } = await request.json()
        sent.push(cursor)
        // The first cursor is refused, as after a change to the suite's schema (I2).
        if (cursor && sent.length === 2) {
          return errorResponse(400, 'invalid_request', 'This cursor was not issued here.')
        }
        if (!cursor && sent.length > 1) await restart.promise
        const sample: Sample = cursor ? ['c20', 'r2', 2] : ['c10', 'r1', 1]
        return HttpResponse.json(cursorPage([pointOf('m1', 'a', sample)], cursor ? null : '1'))
      }),
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')

    await waitFor(() => expect(sent).toEqual([null, '1', null]))
    // Drawn once the chart catches up with the data, which it redraws at most every so often.
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1']))
    expect(main().queryByRole('alert')).not.toBeInTheDocument()

    act(() => restart.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(sent).toEqual([null, '1', null, '1'])
  })

  it('loads a test deselected while loading again from its first page once reselected', async () => {
    mockWorld()
    const [first, again] = [gate(), gate()]
    let seconds = 0
    const sent = mockTwoPages(async () => {
      await (++seconds === 1 ? first : again).promise
      return null
    })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a')
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1']))

    fireEvent.click(box('a'))
    fireEvent.click(box('a'))

    await waitFor(() => expect(sent).toEqual([null, '1', null, '1']))
    expect(main().getByText('1 of 3 tests selected, loading...')).toBeInTheDocument()
    act(() => again.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(main().getByText('1 of 3 tests selected')).toBeInTheDocument()
    act(() => first.open())
  })

  it('stops loading a test once it is deselected', async () => {
    const held = gate()
    const recorded = mockWorld()
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        recorded.queries.push({ body: await request.json(), signal: request.signal })
        await held.promise
        return HttpResponse.json(cursorPage([]))
      }),
    )
    renderPage(`${GRAPHED}&test=a`)
    await waitFor(() => expect(recorded.queries).toHaveLength(1))

    fireEvent.click(box('a'))

    await waitFor(() => expect(recorded.queries[0].signal.aborted).toBe(true))
    act(() => held.open())
  })

  it('stops loading only the test deselected, not the others', async () => {
    const held = gate()
    const recorded = mockWorld()
    server.use(
      mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
        recorded.queries.push({ body: await request.json(), signal: request.signal })
        await held.promise
        return HttpResponse.json(cursorPage([]))
      }),
    )
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time&test=a&test=b')
    await waitFor(() => expect(recorded.queries).toHaveLength(2))

    fireEvent.click(box('a'))

    const of = (test: string) => recorded.queries.find(({ body }) => body.test![0] === test)!
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
    renderPage('/graph?suite=nope&machine=m1&metric=execution_time&test=a')
    await waitFor(() => expect(currentUrl()).toBe('/graph'))
  })

  it('drops a machine that does not exist, and a metric that is not numeric', async () => {
    mockWorld()
    renderPage('/graph?suite=libcxx&machine=gone&machine=m1&metric=hash')
    await waitFor(() => expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m1'))
  })
})
