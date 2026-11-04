import { useQueries } from '@tanstack/react-query'
import { compareStrings } from '../format'
import { api, MAX_PAGE_SIZE, unwrap } from './client'
import { failuresOf } from './failures'
import { fetchEveryPage } from './fetch-every-page'
import { queryKeys } from './keys'
import type { SuiteRef } from './suites'

/** The names of every test with a value for `metric` on `machine` (E5), however many pages. */
async function fetchTestNames(
  suite: SuiteRef,
  machine: string,
  metric: string,
  signal: AbortSignal,
): Promise<string[]> {
  const tests = await fetchEveryPage((cursor) =>
    unwrap(
      api.GET('/api/projects/{project}/suites/{suite}/tests', {
        params: {
          path: suite,
          query: { machine, metric, cursor, limit: MAX_PAGE_SIZE },
        },
        signal,
      }),
    ),
  )
  return tests.map((test) => test.name)
}

/** What is known of the tests of several machines (see `useTestNames`). */
export interface TestNames {
  /** The names of the tests listed so far, sorted. */
  names: string[]
  /** Whether every machine's tests are listed, for every metric. */
  complete: boolean
  /** Why some machine's tests could not be listed, if they could not. */
  error: Error | null
  /** List again the tests that could not be. */
  retry(): void
  /** The tests of each machine listed so far, by metric, then by machine. */
  byMetric: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>
}

/** The tests of one machine for one metric, as cached. */
interface MachineTests {
  machine: string
  metric: string
  names: string[]
}

/** The query listing the tests with a value for `metric` on `machine` (see `fetchTestNames`). */
function testNamesQuery(suite: SuiteRef, machine: string, metric: string) {
  return {
    queryKey: [...queryKeys.tests(suite), { machine, metric }],
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<MachineTests> => ({
      machine,
      metric,
      names: await fetchTestNames(suite, machine, metric, signal),
    }),
  }
}

/**
 * `testNamesQuery`, never fetched again, and cached until removed, as the Graph page does once it
 * leaves the suite or the page (GR8).
 */
export function keptTestNamesQuery(suite: SuiteRef, machine: string, metric: string) {
  return { ...testNamesQuery(suite, machine, metric), staleTime: Infinity, gcTime: Infinity }
}

/**
 * The names of the tests with a value for one of `metrics` on any of `machines`, sorted by code
 * point: the union of one `GET tests?machine=...&metric=...` per machine and metric, every page of
 * it, each cached on its own, so that adding a machine or a metric lists only its own tests. While
 * some are being listed, those already listed are kept. With `keep`, the lists are never fetched
 * again, and stay cached until removed, as the Graph page does once it leaves their suite (GR8).
 */
export function useTestNames(
  suite: SuiteRef,
  machines: readonly string[],
  metrics: readonly string[],
  { keep = false }: { keep?: boolean } = {},
): TestNames {
  return useQueries({
    queries: metrics.flatMap((metric) =>
      machines.map((machine) =>
        (keep ? keptTestNamesQuery : testNamesQuery)(suite, machine, metric),
      ),
    ),
    combine: combineNames,
  })
}

/**
 * The union of the machines' tests. A function of its own, so that it is only run again when a
 * result changes, and the names are the same array from one render to the next until then.
 */
function combineNames(
  results: { data?: MachineTests; error: Error | null; refetch: () => unknown }[],
): TestNames {
  const listed = results.flatMap((result) => (result.data ? [result.data] : []))
  const names = new Set(listed.flatMap((tests) => tests.names))
  const byMetric = new Map<string, Map<string, ReadonlySet<string>>>()
  for (const { machine, metric, names } of listed) {
    let machines = byMetric.get(metric)
    if (machines === undefined) byMetric.set(metric, (machines = new Map()))
    machines.set(machine, new Set(names))
  }
  return {
    names: [...names].sort(compareStrings),
    complete: results.every((result) => result.data !== undefined),
    ...failuresOf(results),
    byMetric,
  }
}
