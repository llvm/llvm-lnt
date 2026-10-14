/**
 * The measurements the Graph page plots (GR2), loaded from `POST /query` (E9) as they are needed:
 * one query per selected test and machine, whose pages are added to its measurements as they
 * arrive, so that the chart fills in as they do. Tests are not batched into one request: a page
 * costs the server about the same however few tests it names, and the pages of a batch would have
 * to be fetched one after the other, whereas the tests' requests run side by side.
 *
 * A test's query stays fresh for good once every page has arrived, and is never fetched again while
 * the page shows it. Until then, it is stale: one cancelled because its test was deselected or its
 * machine removed keeps the pages that had arrived, since TanStack Query keeps what a query
 * function writes as it goes, and is fetched again once its test is shown again. A query fetched
 * again, after a failure or a cancellation, starts from its first page, so that no sample is
 * counted twice.
 *
 * What a page has fetched is kept for as long as it shows the suite, even what it no longer shows
 * (GR8), and forgotten once it leaves it (see `forgetGraphData`).
 */

import { useCallback, useMemo } from 'react'
import {
  experimental_streamedQuery as streamedQuery,
  useQueries,
  type Query,
  type QueryClient,
} from '@tanstack/react-query'
import { api, MAX_PAGE_SIZE, unwrap, type Schemas } from './client'
import { failuresOf } from './failures'
import { queryKeys } from './keys'
import { RequestSlots } from './request-slots'
import { scaffoldKey } from './scaffold'
import { rejectsCursor } from './use-cursor-pages'

/** One sample of a test, as the Graph page keeps it. */
export interface Measurement {
  commit: string
  /** The run's UUID. */
  run: string
  /** When the run was measured. */
  measured: string
  value: number
}

/** A point `POST /query` returned (E9), as the Graph page keeps it. */
export function measurementOf(point: Schemas['DataPoint']): Measurement {
  // The Graph page plots numeric metrics only (GR1).
  const { commit, run_uuid: run, measured_at: measured, value } = point
  return { commit, run, measured, value: value as number }
}

/** How far a trace's measurements are loaded. */
export type TraceState = 'loading' | 'failed' | 'complete'

export interface Series {
  /**
   * The measurements of `test` on `machine` loaded so far, in no particular order: the same array
   * until more of them arrive.
   */
  measurementsOf(machine: string, test: string): readonly Measurement[]
  /** How far the measurements of `test` on `machine` are loaded, while the test is selected. */
  stateOf(machine: string, test: string): TraceState
  /** The selected tests whose measurements are still loading on some machine. */
  loading: ReadonlySet<string>
  /** Why some test's measurements could not be loaded, if they could not. */
  error: Error | null
  /** Load again the tests whose measurements could not be. */
  retry(): void
}

/**
 * At most how many pages of measurements are fetched at once, for every test and machine together,
 * so that a large selection queues its requests rather than sending them to the server all at once.
 */
const slots = new RequestSlots(6)

/** A selected test on a machine whose list holds it: a trace, whose measurements a query loads. */
interface Trace {
  machine: string
  test: string
}

/** A page of a trace's measurements, whether it starts them over (see `pagesOf`), and the last. */
interface Chunk {
  measurements: Measurement[]
  restart: boolean
  last: boolean
}

/** A trace's measurements, as far as they are loaded. */
interface Measured {
  measurements: Measurement[]
  /** Whether every page has arrived. */
  complete: boolean
}

async function fetchPage(
  suite: string,
  metric: string,
  { machine, test }: Trace,
  cursor: string | null,
  signal: AbortSignal,
) {
  const page = await slots.run(signal, () =>
    unwrap(
      api.POST('/api/suites/{testsuite}/query', {
        params: { path: { testsuite: suite } },
        // By commit: the order the server serves fastest for a machine and a test.
        body: { metric, machine, test: [test], sort: 'commit', limit: MAX_PAGE_SIZE, cursor },
        signal,
      }),
    ),
  )
  return {
    measurements: page.items.map(measurementOf),
    next: page.cursor.next,
  }
}

/**
 * The pages of a trace's measurements, one after the other. If the server refuses the cursor of a
 * later page, which may only mean that the server or the suite's schema changed meanwhile (I2), the
 * pages are fetched again from the first, once, which replaces those fetched before it.
 */
async function* pagesOf(
  suite: string,
  metric: string,
  trace: Trace,
  signal: AbortSignal,
): AsyncGenerator<Chunk> {
  let cursor: string | null = null
  let restarted = false
  for (;;) {
    let page
    try {
      page = await fetchPage(suite, metric, trace, cursor, signal)
    } catch (error) {
      if (cursor === null || restarted || !rejectsCursor(error)) throw error
      restarted = true
      cursor = null
      continue
    }
    const last = page.next === null
    yield { measurements: page.measurements, restart: restarted && cursor === null, last }
    if (last) return
    cursor = page.next
  }
}

const NO_MEASUREMENTS: Measurement[] = []

const NOTHING_MEASURED: Measured = { measurements: NO_MEASUREMENTS, complete: false }

/**
 * A trace's measurements once `chunk` has arrived: a new array, so that its points are computed
 * again (see graph-chart.tsx), complete once the last page has.
 */
function addChunk({ measurements }: Measured, chunk: Chunk): Measured {
  return {
    measurements: chunk.restart ? chunk.measurements : measurements.concat(chunk.measurements),
    complete: chunk.last,
  }
}

/** How long a trace's measurements stay fresh: for good once complete, not at all until then. */
function freshness(query: Query<Measured>): number {
  return query.state.data?.complete ? Infinity : 0
}

/**
 * The measurements of the `selected` tests for `metric`, on each machine of `testsOf`, which gives
 * the tests each machine's list holds: a test it does not hold is not asked for, since the API
 * refuses a request naming a test that does not exist (E9).
 */
export function useSeries(
  suite: string,
  metric: string,
  selected: ReadonlySet<string>,
  testsOf: ReadonlyMap<string, ReadonlySet<string>>,
): Series {
  const traces = useMemo(() => {
    const wanted: Trace[] = []
    for (const [machine, held] of testsOf) {
      for (const test of selected) if (held.has(test)) wanted.push({ machine, test })
    }
    return wanted
  }, [testsOf, selected])
  const combine = useCallback((results: TraceResult[]) => combineTraces(traces, results), [traces])
  return useQueries({
    queries: traces.map((trace) => ({
      queryKey: [...queryKeys.series(suite), { metric, ...trace }],
      queryFn: streamedQuery<Chunk, Measured>({
        streamFn: ({ signal }) => pagesOf(suite, metric, trace, signal),
        reducer: addChunk,
        initialValue: NOTHING_MEASURED,
        // Fetched again from the first page, dropping the pages it had.
        refetchMode: 'reset',
      }),
      staleTime: freshness,
      // Kept for as long as the page shows the suite, whose leaving forgets them (GR8; see
      // `forgetGraphData`).
      gcTime: Infinity,
      // Measurements are read whole, never compared with previous ones.
      structuralSharing: false,
    })),
    combine,
  })
}

/** The parts of a trace's query result the series is made of. */
interface TraceResult {
  data?: Measured
  error: Error | null
  isFetching: boolean
  refetch: () => unknown
}

const traceKey = (machine: string, test: string) => `${machine}\0${test}`

/** The series of `traces`, from the results of their queries, in order. */
function combineTraces(traces: Trace[], results: TraceResult[]): Series {
  const measurements = new Map<string, readonly Measurement[]>()
  const states = new Map<string, TraceState>()
  const loading = new Set<string>()
  results.forEach(({ data, error, isFetching }, i) => {
    const { machine, test } = traces[i]
    const key = traceKey(machine, test)
    if (data !== undefined) measurements.set(key, data.measurements)
    // Until its every page has arrived, or one has failed and is not being fetched again.
    if (isFetching || (data === undefined && error === null)) loading.add(test)
    states.set(
      key,
      isFetching ? 'loading' : error !== null ? 'failed' : data?.complete ? 'complete' : 'loading',
    )
  })
  return {
    measurementsOf: (machine, test) =>
      measurements.get(traceKey(machine, test)) ?? NO_MEASUREMENTS,
    stateOf: (machine, test) => states.get(traceKey(machine, test)) ?? 'loading',
    loading,
    ...failuresOf(results),
  }
}

/**
 * Forget what the Graph page fetched in `suite` and no longer shows -- its measurements, its
 * scaffolds and its lists of tests, which it keeps for as long as it shows the suite (GR8) -- once
 * it has left the suite or the page. Done after the current task, and only to what nothing
 * observes then, so that a page mounted again at once, as StrictMode does in development, keeps
 * what it is still showing.
 */
export function forgetGraphData(client: QueryClient, suite: string): void {
  setTimeout(() => {
    for (const queryKey of [queryKeys.series(suite), scaffoldKey(suite), queryKeys.tests(suite)]) {
      client.removeQueries({ queryKey, predicate: (query) => query.getObserversCount() === 0 })
    }
  })
}
