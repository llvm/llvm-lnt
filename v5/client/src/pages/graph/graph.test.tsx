import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { Layout, PlotData } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { colorOfName } from '../../chart-colors'
import { BARE_SUITE, SUITE, commit, cursorPage, machine, metric } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { chartProps } from '../../test/chart-props'
import {
  currentUrl,
  gate,
  main,
  mockCommits,
  mockMachines,
  mockSuites,
  mockTests,
  renderPage,
  search,
} from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

// The tests check what the page hands Plotly to draw (see test/chart.tsx).
vi.mock('../../components/chart', () => import('../../test/chart'))

/** libcxx, with two numeric metrics and one that cannot be plotted. */
const GRAPH_SUITE: SuiteSchema = {
  ...SUITE,
  metrics: [
    SUITE.metrics[0],
    metric('compile_time', { display_name: 'Compile Time' }),
    metric('hash', { type: 'text' }),
  ],
}

/** A suite with a metric, but none numeric. */
const TEXT_SUITE: SuiteSchema = {
  ...BARE_SUITE,
  name: 'text_only',
  metrics: [metric('hash', { type: 'text' })],
}

/** A sample: its commit, its run (one per letter), and its value. */
type Sample = [commit: string, run: string, value: number]

interface World {
  machines?: string[]
  /** The tests of each machine, for any metric. */
  tests?: Record<string, string[]>
  /** The commits each machine has runs at, by ordinal. */
  commits?: Record<string, number[]>
  /** The samples of each test on each machine, under `machine/test`. */
  samples?: Record<string, Sample[]>
  /** How many points a page of `POST /query` holds. */
  pageSize?: number
  /** What the list of suites waits for before it is answered. */
  suitesWait?: () => Promise<void>
}

const MACHINES = ['m1', 'm2']
const TESTS = { m1: ['a', 'b', 'c'], m2: ['b', 'c', 'd'] }
const COMMITS = { m1: [10, 20, 30], m2: [20, 30, 40] }
const SAMPLES: Record<string, Sample[]> = {
  'm1/a': [
    ['c10', 'r1', 1],
    ['c20', 'r2', 2],
  ],
  'm1/b': [['c10', 'r1', 3]],
  'm2/b': [['c40', 'r3', 4]],
}

const commitAt = (ordinal: number) =>
  commit(`c${ordinal}`, { ordinal, fields: { svn_revision: `r${ordinal}`, commit_info: null } })

const pointOf = (machineName: string, test: string, [value, run, measured]: Sample) =>
  ({
    test,
    machine: machineName,
    metric: 'execution_time',
    value: measured,
    commit: value,
    ordinal: Number(value.slice(1)),
    run_uuid: run,
    submitted_at: '2026-08-25T14:22:41Z',
    tag: null,
  }) satisfies Schemas['DataPoint']

/** The bodies `POST /query` was sent, in order, and the signal of each request. */
interface Recorded {
  queries: { body: Schemas['QueryRequest']; signal: AbortSignal }[]
}

/** Mock the API for the Graph page: GRAPH_SUITE and TEXT_SUITE, and the world described. */
function mockWorld({
  machines = MACHINES,
  tests = TESTS,
  commits = COMMITS,
  samples = SAMPLES,
  pageSize = 10_000,
  suitesWait,
}: World = {}): Recorded {
  const recorded: Recorded = { queries: [] }
  mockSuites([GRAPH_SUITE, TEXT_SUITE], { wait: suitesWait })
  mockMachines(() => ({ items: machines.map((name) => machine(name)) }))
  mockTests((query) => testPage(tests[query.get('machine')!] ?? []))
  mockCommits((query) => cursorPage((commits[query.get('machine')!] ?? []).map(commitAt)))
  server.use(
    mockApi('post', '/api/suites/{testsuite}/query', async ({ request }) => {
      const body = await request.json()
      recorded.queries.push({ body, signal: request.signal })
      const all = (body.test ?? []).flatMap((test) =>
        (samples[`${body.machine}/${test}`] ?? []).map((s) => pointOf(body.machine!, test, s)),
      )
      const start = Number(body.cursor ?? 0)
      const end = start + pageSize
      const next = end < all.length ? String(end) : null
      return HttpResponse.json(cursorPage(all.slice(start, end), next))
    }),
  )
  return recorded
}

/** A page of `GET /tests` listing `names`. */
function testPage(names: string[]) {
  return cursorPage(names.map((name) => ({ name })))
}

/** What the page last handed the chart to draw. */
function chart() {
  return chartProps(main().getByRole('img'))
}

/** The traces the chart was last given, as `name: commit=value...`. */
function traces() {
  return chart().data.map((trace) => {
    const { name, x, y } = trace as PlotData
    const points = (x as string[]).map((value, i) => `${value}=${(y as number[])[i]}`)
    return `${name}: ${points.join(' ')}`
  })
}

function layout(): Partial<Layout> {
  return chart().layout
}

function testTable() {
  return within(main().getByRole('table', { name: 'Tests' }))
}

/** The tests the table lists, in order. */
function listed() {
  return testTable()
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2].textContent)
}

const box = (test: string) => testTable().getByRole('checkbox', { name: test })

async function addMachine(name: string) {
  const user = userEvent.setup()
  const input = await screen.findByRole('combobox', { name: 'Machines' })
  await waitFor(() => expect(input).toBeEnabled())
  await user.type(input, name)
  await user.click(await screen.findByRole('option', { name }))
}

/** The query of the URL the page is at, by parameter, whatever their order. */
function query() {
  const params = new URLSearchParams(currentUrl()!.split('?')[1] ?? '')
  const entries: Record<string, string[]> = {}
  for (const [key, value] of params) (entries[key] ??= []).push(value)
  return entries
}

const GRAPHED = '/graph?suite=libcxx&machine=m1&machine=m2&metric=execution_time'

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

  it('drops the tests of the URL that its filter hides (GR14)', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test_filter=b&test=a&test=b`)

    await waitFor(() => expect(query()).toMatchObject({ test: ['b'] }))
    expect(listed()).toEqual(['b'])
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

  it('prunes the tests the filter hides, in substring or regex mode', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(box('b')).toBeChecked())

    search('Filter tests', 'b')
    await waitFor(() => expect(listed()).toEqual(['b']))
    expect(main().getByText('1 of 1 matching tests selected (4 total)')).toBeInTheDocument()
    await waitFor(() => expect(query()).toMatchObject({ test_filter: ['b'], test: ['b'] }))

    fireEvent.click(screen.getByRole('checkbox', { name: 'Regex' }))
    search('Filter tests', '^[bc]$')
    await waitFor(() => expect(listed()).toEqual(['b', 'c']))
    await waitFor(() =>
      expect(query()).toMatchObject({
        test_filter: ['^[bc]$'],
        test_filter_regex: ['true'],
        test: ['b'],
      }),
    )
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
