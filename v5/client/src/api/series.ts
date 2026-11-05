/**
 * The measurements the Graph page plots (GR2), loaded from `GET /series` (E9) as they are needed:
 * one request per selected test, metric and machine, whose measurements are drawn once they have
 * all arrived. Tests are not batched into one request, so that each is drawn as soon as its own
 * data has arrived, and the tests' requests run side by side, a few at a time, taking turns with
 * the baselines' (see `fetchMeasurements`).
 *
 * Once loaded, a test's measurements are kept as they are, fresh for good (GR8), and never fetched
 * again while the page shows them. A request cancelled because its test was deselected, or its
 * machine or metric removed, keeps none of what had arrived, and is sent again once its test is
 * shown again.
 *
 * What a page has fetched is kept for as long as it shows the suite, even what it no longer shows
 * (GR8), and forgotten once it leaves it (see `forgetGraphData`).
 */

import { useCallback, useMemo } from 'react'
import { useQueries, type QueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { failuresOf } from './failures'
import { queryKeys } from './keys'
import { readNdjson } from './ndjson'
import { RequestSlots } from './request-slots'
import type { operations } from './schema'
import { scaffoldKey } from './scaffold'
import type { SuiteRef } from './suites'

/** One sample of a test, as the Graph page keeps it. */
export interface Measurement {
  commit: string
  /** The run's UUID. */
  run: string
  /** When the run was measured. */
  measured: string
  value: number
}

/** A line of `GET /series` (E9), as the Graph page keeps it. */
function measurementOf(point: Schemas['DataPoint']): Measurement {
  // The Graph page plots numeric metrics only (GR1).
  const { commit, run_uuid: run, measured_at: measured, value } = point
  return { commit, run, measured, value: value as number }
}

type SeriesQuery = operations['get_series']['parameters']['query']

/** Every line of `GET /series` in `suite` for `query`, once the whole response has arrived. */
export async function fetchSeries(
  suite: SuiteRef,
  query: SeriesQuery,
  signal: AbortSignal,
): Promise<Schemas['DataPoint'][]> {
  const body = await unwrap(
    api.GET('/api/projects/{project}/suites/{suite}/series', {
      params: { path: suite, query },
      parseAs: 'stream',
      signal,
    }),
  )
  return readNdjson(body, signal)
}

export interface Series {
  /**
   * The measurements of `test` for `metric` on `machine`, in no particular order, once they have
   * arrived.
   */
  measurementsOf(metric: string, machine: string, test: string): readonly Measurement[]
  /** The selected tests whose measurements are still loading on some machine, for some metric. */
  loading: ReadonlySet<string>
  /** The metrics some of whose measurements are still loading, or could not be loaded. */
  unsettled: ReadonlySet<string>
  /** Why some test's measurements could not be loaded, if they could not. */
  error: Error | null
  /** Load again the tests whose measurements could not be. */
  retry(): void
}

/**
 * At most how many tests' measurements are fetched at once, for every machine and baseline
 * together, so that a large selection queues its requests rather than sending them to the server
 * all at once (GR2). A request holds its slot until its whole response has arrived.
 */
const slots = new RequestSlots(6)

/**
 * The measurements of every line of `GET /series` in `suite` for `query`, fetched once one of the
 * Graph page's turns to send a request is free (see `slots`).
 */
export async function fetchMeasurements(
  suite: SuiteRef,
  query: SeriesQuery,
  signal: AbortSignal,
): Promise<Measurement[]> {
  const points = await slots.run(signal, () => fetchSeries(suite, query, signal))
  return points.map(measurementOf)
}

/**
 * A selected test on a machine whose list for a metric holds it: a trace, whose measurements a
 * query loads.
 */
interface Trace {
  metric: string
  machine: string
  test: string
}

/**
 * The measurements of a trace. Only those of commits with an ordinal, the only ones the x-axis
 * places (GR3).
 */
function fetchTrace(
  suite: SuiteRef,
  { metric, machine, test }: Trace,
  signal: AbortSignal,
): Promise<Measurement[]> {
  return fetchMeasurements(suite, { metric, machine, test: [test], has_ordinal: true }, signal)
}

const NO_MEASUREMENTS: Measurement[] = []

/**
 * The measurements of the `selected` tests for each of `metrics`, on each machine of `testsOf`,
 * which gives the tests each machine's list holds for each metric: a test it does not hold is not
 * asked for, since it has no value for the metric there, and the API refuses a request naming a
 * test that does not exist (E9).
 */
export function useSeries(
  suite: SuiteRef,
  metrics: readonly string[],
  selected: ReadonlySet<string>,
  testsOf: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>,
): Series {
  const traces = useMemo(() => {
    const wanted: Trace[] = []
    for (const metric of metrics) {
      for (const [machine, held] of testsOf.get(metric) ?? []) {
        for (const test of selected) if (held.has(test)) wanted.push({ metric, machine, test })
      }
    }
    return wanted
  }, [metrics, testsOf, selected])
  const combine = useCallback((results: TraceResult[]) => combineTraces(traces, results), [traces])
  return useQueries({
    queries: traces.map((trace) => ({
      queryKey: [...queryKeys.series(suite), trace],
      queryFn: ({ signal }) => fetchTrace(suite, trace, signal),
      staleTime: Infinity,
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
  data?: Measurement[]
  error: Error | null
  isFetching: boolean
  refetch: () => unknown
}

const traceKey = (metric: string, machine: string, test: string) =>
  `${metric}\0${machine}\0${test}`

/** The series of `traces`, from the results of their queries, in order. */
function combineTraces(traces: Trace[], results: TraceResult[]): Series {
  const measurements = new Map<string, readonly Measurement[]>()
  const loading = new Set<string>()
  const unsettled = new Set<string>()
  results.forEach(({ data, error, isFetching }, i) => {
    const { metric, machine, test } = traces[i]
    if (data !== undefined) measurements.set(traceKey(metric, machine, test), data)
    // Until its measurements have arrived, or it has failed and is not being fetched again.
    const pending = isFetching || (data === undefined && error === null)
    if (pending) loading.add(test)
    if (pending || error !== null) unsettled.add(metric)
  })
  return {
    measurementsOf: (metric, machine, test) =>
      measurements.get(traceKey(metric, machine, test)) ?? NO_MEASUREMENTS,
    loading,
    unsettled,
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
export function forgetGraphData(client: QueryClient, suite: SuiteRef): void {
  setTimeout(() => {
    for (const queryKey of [queryKeys.series(suite), scaffoldKey(suite), queryKeys.tests(suite)]) {
      client.removeQueries({ queryKey, predicate: (query) => query.getObserversCount() === 0 })
    }
  })
}
