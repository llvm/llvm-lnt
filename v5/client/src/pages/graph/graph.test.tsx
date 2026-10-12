import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import type { Layout, PlotData } from 'plotly.js'
import { describe, expect, it, vi } from 'vitest'
import type { Schemas } from '../../api/client'
import type { SuiteSchema } from '../../api/suites'
import { traceColor } from '../../chart-colors'
import type { ChartProps } from '../../components/chart'
import { BARE_SUITE, SUITE, commit, cursorPage, machine, metric } from '../../test/fixtures'
import { errorResponse, mockApi } from '../../test/mock-api'
import { currentUrl, gate, main, mockSuites, renderPage, search } from '../../test/page'
import { pickOption, selectButton } from '../../test/select'
import { server } from '../../test/server'

// Plotly cannot draw in jsdom. The tests check what the page hands it instead: the props the chart
// was last rendered with.
const charts = vi.hoisted(() => ({ last: null as ChartProps | null }))
vi.mock('../../components/chart', () => ({
  Chart: (props: ChartProps) => {
    charts.last = props
    return <div role="img" aria-label={props.label} />
  },
}))

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

/** The query bodies `POST /query` was sent, in order, and the signal of each request. */
interface Recorded {
  queries: { body: Schemas['QueryRequest']; signal: AbortSignal }[]
  tests: URLSearchParams[]
  commits: URLSearchParams[]
}

/** Mock the API for the Graph page: GRAPH_SUITE and TEXT_SUITE, and the world described. */
function mockWorld({
  machines = MACHINES,
  tests = TESTS,
  commits = COMMITS,
  samples = SAMPLES,
  pageSize = 10_000,
}: World = {}): Recorded {
  const recorded: Recorded = { queries: [], tests: [], commits: [] }
  mockSuites([GRAPH_SUITE, TEXT_SUITE])
  server.use(
    mockApi('get', '/api/suites/{testsuite}/machines', () =>
      HttpResponse.json({ items: machines.map((name) => machine(name)) }),
    ),
    mockApi('get', '/api/suites/{testsuite}/tests', ({ request }) => {
      const query = new URL(request.url).searchParams
      recorded.tests.push(query)
      const names = tests[query.get('machine')!] ?? []
      return HttpResponse.json(cursorPage(names.map((name) => ({ name }))))
    }),
    mockApi('get', '/api/suites/{testsuite}/commits', ({ request }) => {
      const query = new URL(request.url).searchParams
      recorded.commits.push(query)
      return HttpResponse.json(cursorPage((commits[query.get('machine')!] ?? []).map(commitAt)))
    }),
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

/** The traces the chart was last given, as `name: [commit, value]...`. */
function traces() {
  return (charts.last?.data ?? []).map((trace) => {
    const { name, x, y } = trace as PlotData
    const points = (x as string[]).map((value, i) => `${value}=${(y as number[])[i]}`)
    return `${name}: ${points.join(' ')}`
  })
}

function layout(): Partial<Layout> {
  return charts.last!.layout
}

function table() {
  return within(main().getByRole('table', { name: 'Tests' }))
}

/** The tests the table lists, in order. */
function listed() {
  return table()
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2].textContent)
}

const box = (test: string) => table().getByRole('checkbox', { name: test })

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

    await waitFor(() => expect(selectButton('Suite')).toBeEnabled())
    expect(selectButton('Suite')).toHaveTextContent('-- Select suite --')
    expect(screen.getByRole('combobox', { name: 'Machines' })).toBeDisabled()
    expect(selectButton('Metric')).toBeDisabled()
    expect(screen.getByRole('searchbox', { name: 'Filter tests' })).toBeDisabled()
    expect(main().getByText('Select a suite first.')).toBeInTheDocument()
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
  })

  it("lists every test the machines have for the metric, and plots none of them", async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)

    await waitFor(() => expect(listed()).toEqual(['a', 'b', 'c', 'd']))
    expect(main().getByRole('status', { name: '' })).toBeDefined()
    expect(main().getByText('0 of 4 tests selected')).toBeInTheDocument()
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

  it('gives a test a colour by its place in the list, and a machine its marker', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=b`)

    await waitFor(() => expect(traces()).toEqual(['b - m1: c10=3', 'b - m2: c40=4']))
    const data = charts.last!.data as PlotData[]
    expect(data.map((trace) => trace.line.color)).toEqual([traceColor(1), traceColor(1)])
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

    fireEvent.click(table().getByText('b'))
    expect(box('b')).toBeChecked()
    fireEvent.click(box('b'))
    expect(box('b')).not.toBeChecked()
  })

  it('isolates a test on a double-click, and selects every test back on another', async () => {
    mockWorld()
    renderPage(`${GRAPHED}&test=a&test=b`)
    await waitFor(() => expect(box('a')).toBeChecked())

    fireEvent.doubleClick(table().getByText('c'))
    expect(currentUrl()).toBe(`${GRAPHED}&test=c`)
    fireEvent.doubleClick(table().getByText('c'))
    expect(currentUrl()).toBe(`${GRAPHED}&test=a&test=b&test=c&test=d`)
  })

  it('keeps at most 10 tests in the URL, and warns once the selection is not in it', async () => {
    const names = Array.from({ length: 11 }, (_, i) => `t${String(i).padStart(2, '0')}`)
    mockWorld({ tests: { m1: names } })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(11))

    fireEvent.click(table().getByRole('checkbox', { name: 'Select all tests shown' }))

    expect(currentUrl()).toBe('/graph?suite=libcxx&machine=m1&metric=execution_time')
    expect(main().getByText(/the selection is not part of the URL/)).toBeInTheDocument()
    fireEvent.click(box('t00'))
    expect(currentUrl()).toContain('&test=t01&test=t02')
    expect(main().queryByText(/the selection is not part of the URL/)).not.toBeInTheDocument()
  })

  it('selects at most 100 tests', async () => {
    const names = Array.from({ length: 101 }, (_, i) => `t${String(i).padStart(3, '0')}`)
    mockWorld({ tests: { m1: names } })
    renderPage('/graph?suite=libcxx&machine=m1&metric=execution_time')
    await waitFor(() => expect(listed()).toHaveLength(101))

    const all = table().getByRole('checkbox', { name: 'Select all tests shown' })
    expect(all).toBeDisabled()
    expect(all).toHaveAccessibleDescription('At most 100 tests can be selected at once.')
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
    server.use(
      mockApi('get', '/api/suites/{testsuite}/tests', async ({ request }) => {
        await lists.promise
        const query = new URL(request.url).searchParams
        const names = query.get('machine') === 'm1' ? ['b'] : ['b', 'd']
        return HttpResponse.json(cursorPage(names.map((name) => ({ name }))))
      }),
    )

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
    expect(table().getByText('(loading...)')).toBeInTheDocument()

    act(() => second.open())
    await waitFor(() => expect(traces()).toEqual(['a - m1: c10=1 c20=2']))
    expect(main().getByText('1 of 3 tests selected')).toBeInTheDocument()
  })

  it('asks for the tests selected together in one request per machine', async () => {
    const recorded = mockWorld()
    renderPage(GRAPHED)
    await waitFor(() => expect(listed()).toHaveLength(4))

    fireEvent.click(table().getByRole('checkbox', { name: 'Select all tests shown' }))

    await waitFor(() => expect(recorded.queries).toHaveLength(2))
    expect(recorded.queries.map(({ body }) => [body.machine, body.test])).toEqual([
      ['m1', ['a', 'b', 'c']],
      ['m2', ['b', 'c', 'd']],
    ])
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
        const query = new URL(request.url).searchParams
        if (query.get('machine') === 'm2' && failing) {
          return errorResponse(500, 'internal_error', 'The commits broke.')
        }
        return HttpResponse.json(cursorPage(COMMITS[query.get('machine') as 'm1'].map(commitAt)))
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

  it('fetches again only the page that failed, adding no point twice', async () => {
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
    expect(sent).toEqual([null, '1', '1'])
  })

  it("says why the machines' tests could not be listed, and tries again", async () => {
    mockWorld()
    let failing = true
    server.use(
      mockApi('get', '/api/suites/{testsuite}/tests', () =>
        failing
          ? errorResponse(500, 'internal_error', 'The tests broke.')
          : HttpResponse.json(cursorPage([{ name: 'a' }])),
      ),
    )
    renderPage(GRAPHED)

    expect(
      await main().findByText(/The tests could not be listed: The tests broke\./),
    ).toBeInTheDocument()
    failing = false
    fireEvent.click(within(main().getByRole('alert')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(listed()).toEqual(['a']))
  })
})

describe('the URL (GR14, AR2)', () => {
  it('drops a suite, a machine or a metric that cannot be used', async () => {
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
