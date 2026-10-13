/**
 * The baselines of the Graph page (GR9): what the URL says of them, whether each is usable, and
 * their data.
 */

import { useMemo } from 'react'
import { skipToken, useQueries, type QueryClient } from '@tanstack/react-query'
import { api, MAX_PAGE_SIZE, unwrap } from '../../api/client'
import { failuresOf, type Failures } from '../../api/failures'
import { fetchEveryPage } from '../../api/fetch-every-page'
import { queryKeys } from '../../api/keys'
import { machinesQuery } from '../../api/machines'
import { measurementOf, type Measurement } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { commitLookupKey, commitLookupQuery } from '../../components/commit-lookup'
import { isNumeric, type Metric } from '../../schema'
import { listParam, type Param } from '../../url-state'

/** A baseline: a commit of a machine, in a suite which may be another than the one plotted. */
export interface Baseline {
  suite: string
  machine: string
  commit: string
}

/** The baseline `text` names, as the URL spells it, or null if it is malformed (GR9). */
export function parseBaseline(text: string): Baseline | null {
  const parts = text.split('/')
  if (parts.length !== 3 || parts.some((part) => part === '')) return null
  const [suite, machine, commit] = parts
  return { suite, machine, commit }
}

/** `baseline`, as the URL spells it: none of its names can contain a `/` (GR9). */
export function formatBaseline({ suite, machine, commit }: Baseline): string {
  return `${suite}/${machine}/${commit}`
}

/** The baselines, repeated once per baseline (GR14), each once; malformed ones are dropped. */
export function baselineParam(): Param<string[]> {
  const list = listParam()
  return {
    ...list,
    parse: (values) => list.parse(values.filter((value) => parseBaseline(value) !== null)),
  }
}

/** What is known of a baseline (see `useBaselines`). */
export interface BaselineState {
  baseline: Baseline
  /** The display value of its commit, or the commit string until it is known. */
  display: string
  /**
   * Whether it is known to be unusable: its suite, its machine or its commit does not exist, or
   * the machine has no run at the commit (AR2 "State").
   */
  unusable: boolean
  /**
   * Its samples, by test, once every one of them has arrived, or undefined until then, and when
   * it draws nothing: when its suite does not declare the metric plotted as one with the same
   * meaning (GR9).
   */
  samples: ReadonlyMap<string, Measurement[]> | undefined
}

/** What is known of the baselines (see `useBaselines`). */
export interface Baselines extends Failures {
  states: BaselineState[]
}

/**
 * Whether `schema` declares `metric` as a metric that can be drawn against it: numeric, and with
 * the same unit, an unset unit matching only an unset one (GR9, CP1).
 */
function declares(schema: SuiteSchema, metric: Metric): boolean {
  return schema.metrics.some(
    (entry) => entry.name === metric.name && isNumeric(entry) && entry.unit === metric.unit,
  )
}

/** Every sample of the baseline's commit for `metric`, of every test, by test (GR9). */
async function fetchSamples(
  { suite, machine, commit }: Baseline,
  metric: string,
  signal: AbortSignal,
): Promise<Map<string, Measurement[]>> {
  // Unsorted, which leaves in a commit without an ordinal (E9), as a commit picker offers (AR15).
  const points = await fetchEveryPage((cursor) =>
    unwrap(
      api.POST('/api/suites/{testsuite}/query', {
        params: { path: { testsuite: suite } },
        body: { metric, machine, commit, limit: MAX_PAGE_SIZE, cursor },
        signal,
      }),
    ),
  )
  const samples = new Map<string, Measurement[]>()
  for (const point of points) {
    const known = samples.get(point.test)
    if (known === undefined) samples.set(point.test, [measurementOf(point)])
    else known.push(measurementOf(point))
  }
  return samples
}

/**
 * The data of several queries shown together, and their failures. Run again only when a result
 * changes, so that the data is the same array from one render to the next until then.
 */
function combine<Data>(results: { data?: Data; error: Error | null; refetch: () => unknown }[]) {
  return { data: results.map((result) => result.data), ...failuresOf(results) }
}

/**
 * What is known of `baselines` (GR9), given the suites, once they are listed, and the metric
 * plotted: whether each is usable, its commit's display value, and its samples. The states are
 * the same array from one render to the next until one of them changes.
 *
 * A baseline is checked as a commit given to a commit picker is (AR15): its suite must be listed,
 * its machine among the suite's, and the machine must have runs at its commit, which the lookup of
 * the commit among the machine's says. The machine is checked first, since the lookup refuses a
 * machine that does not exist, and a request that fails shows nothing (AR2 "State").
 *
 * Its samples are fetched once it is known to be usable, and kept for as long as the page is open
 * (GR8; see `forgetBaselines`).
 */
export function useBaselines(
  baselines: readonly Baseline[],
  suites: readonly SuiteSchema[] | undefined,
  metric: Metric | undefined,
): Baselines {
  const schemas = useMemo(
    () => baselines.map((baseline) => suites?.find((schema) => schema.name === baseline.suite)),
    [baselines, suites],
  )
  const named = useMemo(
    () => [...new Set(schemas.flatMap((schema) => schema?.name ?? []))],
    [schemas],
  )
  const machineLists = useQueries({
    queries: named.map((suite) => ({ ...machinesQuery(suite), staleTime: Infinity })),
    combine,
  })
  // Whether each baseline's machine is among its suite's, once they are listed.
  const machineKnown = useMemo(
    () =>
      baselines.map((baseline, i) => {
        if (schemas[i] === undefined) return undefined
        const list = machineLists.data[named.indexOf(baseline.suite)]
        return list?.some((entry) => entry.name === baseline.machine)
      }),
    [baselines, schemas, named, machineLists.data],
  )

  const lookups = useQueries({
    queries: baselines.map(({ suite, machine, commit }, i) => {
      const schema = schemas[i]
      return {
        queryKey: commitLookupKey(suite, { machine }, commit),
        queryFn:
          schema && machineKnown[i]
            ? commitLookupQuery(schema, { machine }, commit).queryFn
            : skipToken,
      }
    }),
    combine,
  })

  const drawable = useMemo(
    () =>
      baselines.map((_, i) => {
        const schema = schemas[i]
        return (
          metric !== undefined &&
          schema !== undefined &&
          lookups.data[i] != null &&
          declares(schema, metric)
        )
      }),
    [baselines, schemas, metric, lookups.data],
  )
  const samples = useQueries({
    queries: baselines.map((baseline, i) => {
      const { suite, machine, commit } = baseline
      const name = metric?.name ?? ''
      return {
        queryKey: [...queryKeys.baselines(suite), machine, commit, name],
        queryFn: drawable[i]
          ? ({ signal }: { signal: AbortSignal }) => fetchSamples(baseline, name, signal)
          : skipToken,
        staleTime: Infinity,
        gcTime: Infinity,
      }
    }),
    combine,
  })

  const states = useMemo(
    () =>
      baselines.map(
        (baseline, i): BaselineState => ({
          baseline,
          display: lookups.data[i]?.text ?? baseline.commit,
          unusable:
            (suites !== undefined && schemas[i] === undefined) ||
            machineKnown[i] === false ||
            lookups.data[i] === null,
          samples: drawable[i] ? samples.data[i] : undefined,
        }),
      ),
    [baselines, suites, schemas, machineKnown, lookups.data, drawable, samples.data],
  )
  return {
    states,
    error: machineLists.error ?? lookups.error ?? samples.error,
    retry: () => [machineLists, lookups, samples].forEach((group) => group.retry()),
  }
}

/** The baselines named by the URL's `values`, each parsed once. */
export function useParsedBaselines(values: readonly string[]): Baseline[] {
  return useMemo(() => values.flatMap((value) => parseBaseline(value) ?? []), [values])
}

/**
 * Forget the baselines' data that nothing shows, which the Graph page keeps for as long as it is
 * open (GR8), once it has left. Done after the current task, as `forgetGraphData` is.
 */
export function forgetBaselines(client: QueryClient): void {
  setTimeout(() => {
    client.removeQueries({
      predicate: (query) => {
        const [root, suite, what] = query.queryKey
        return (
          root === 'suite' &&
          what === queryKeys.baselines(String(suite))[2] &&
          query.getObserversCount() === 0
        )
      },
    })
  })
}
