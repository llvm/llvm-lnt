/**
 * The baselines of the Graph page (GR9): what the URL says of them, whether each is usable, and
 * their data.
 */

import { useMemo } from 'react'
import { skipToken, useQueries, type QueryClient } from '@tanstack/react-query'
import { combineResults, type Failures } from '../../api/failures'
import { forgetEverySuiteLater, queryKeys } from '../../api/keys'
import { fetchSeries, measurementOf, type Measurement } from '../../api/series'
import type { Suite } from '../../api/suites'
import {
  formatCommitOfMachine,
  parseCommitOfMachine,
  useCheckedCommits,
  type CommitOfMachine,
} from '../../components/checked-commits'
import { fullLabelOf } from '../../labels'
import { isNumeric, type Metric } from '../../schema'
import { listParam, type Param } from '../../url-state'

/** A baseline: a commit of a machine, in a suite which may be another than the one plotted. */
export type Baseline = CommitOfMachine

/** The baseline `text` names, as the URL spells it, or null if it is malformed (GR9). */
export function parseBaseline(text: string): Baseline | null {
  return parseCommitOfMachine(text.split('/'))
}

/** `baseline`, as the URL spells it (GR9). */
export const formatBaseline = formatCommitOfMachine

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
  /** The full label of its suite (AR22), or the suite's names until the suites are listed. */
  suiteLabel: string
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
function declares(schema: Suite, metric: Metric): boolean {
  return schema.metrics.some(
    (entry) => entry.name === metric.name && isNumeric(entry) && entry.unit === metric.unit,
  )
}

/**
 * Every sample of the baseline's commit for `metric`, of every test, by test (GR9). Not queued
 * behind the traces' requests (see api/series.ts), so that a large selection does not hold back a
 * baseline.
 */
async function fetchSamples(
  { suite, machine, commit }: Baseline,
  metric: string,
  signal: AbortSignal,
): Promise<Map<string, Measurement[]>> {
  // Without `has_ordinal`, which leaves in a commit without an ordinal (E9), as a commit picker
  // offers (AR15).
  const points = await fetchSeries(suite, { metric, machine, commit }, signal)
  const samples = new Map<string, Measurement[]>()
  for (const point of points) {
    const known = samples.get(point.test)
    if (known === undefined) samples.set(point.test, [measurementOf(point)])
    else known.push(measurementOf(point))
  }
  return samples
}

/**
 * What is known of `baselines` (GR9), given the suites, once they are listed, and the metric
 * plotted: whether each is usable, its commit's display value, and its samples. The states are
 * the same array from one render to the next until one of them changes.
 *
 * A baseline is checked as a commit given to a commit picker is (AR15; see `useCheckedCommits`).
 * Its samples are fetched once it is known to be usable, and kept for as long as the page is open
 * (GR8; see `forgetBaselines`).
 */
export function useBaselines(
  baselines: readonly Baseline[],
  suites: readonly Suite[] | undefined,
  metric: Metric | undefined,
): Baselines {
  const checked = useCheckedCommits(baselines, suites)

  const drawable = useMemo(
    () =>
      checked.states.map(
        ({ schema, found }) =>
          metric !== undefined &&
          schema !== undefined &&
          found === true &&
          declares(schema, metric),
      ),
    [checked.states, metric],
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
    combine: combineResults,
  })

  const states = useMemo(
    () =>
      baselines.map(
        (baseline, i): BaselineState => ({
          baseline,
          suiteLabel: fullLabelOf(suites, baseline.suite),
          display: checked.states[i].display,
          unusable: checked.states[i].unusable,
          samples: drawable[i] ? samples.data[i] : undefined,
        }),
      ),
    [baselines, suites, checked.states, drawable, samples.data],
  )
  return {
    states,
    error: checked.error ?? samples.error,
    retry: () => [checked, samples].forEach((group) => group.retry()),
  }
}

/** The baselines named by the URL's `values`, each parsed once. */
export function useParsedBaselines(values: readonly string[]): Baseline[] {
  return useMemo(() => values.flatMap((value) => parseBaseline(value) ?? []), [values])
}

/**
 * Forget the baselines' data that nothing shows, which the Graph page keeps for as long as it is
 * open (GR8), once it has left.
 */
export function forgetBaselines(client: QueryClient): void {
  forgetEverySuiteLater(client, queryKeys.baselines)
}
