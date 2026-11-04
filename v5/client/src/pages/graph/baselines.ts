/**
 * The baselines of the Graph page (GR9): what the URL says of them, whether each is usable, and
 * their data.
 */

import { useMemo } from 'react'
import { useQueries, type QueryClient } from '@tanstack/react-query'
import { combineResults, type Failures } from '../../api/failures'
import { forgetEverySuiteLater, queryKeys } from '../../api/keys'
import { fetchMeasurements, type Measurement } from '../../api/series'
import { fullName, type Suite } from '../../api/suites'
import { keptTestNamesQuery } from '../../api/tests'
import {
  formatCommitOfMachine,
  parseCommitOfMachine,
  useCheckedCommits,
  type CommitOfMachine,
} from '../../components/checked-commits'
import { fullLabelOf, joinLabels } from '../../labels'
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
  /** How it is named: its suite's full label, its machine and its commit's display value (GR9). */
  label: string
  /**
   * Whether it is known to be unusable: its suite, its machine or its commit does not exist, or
   * the machine has no run at the commit (AR2 "State").
   */
  unusable: boolean
  /**
   * Its samples, by test, of the selected tests whose samples have all arrived, or undefined
   * while it is not known to be drawable: it draws nothing when its suite does not declare the
   * metric plotted as one with the same meaning (GR9).
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
 * The samples of `test` at the baseline's commit for `metric` (GR9), fetched in turn with the
 * traces' (see api/series.ts). Without `has_ordinal`, which leaves in a commit without an ordinal
 * (E9), as a commit picker offers (AR15).
 */
function fetchSamples(
  { suite, machine, commit }: Baseline,
  metric: string,
  test: string,
  signal: AbortSignal,
): Promise<Measurement[]> {
  return fetchMeasurements(suite, { metric, machine, test: [test], commit }, signal)
}

/** A baseline's machine, as a key. */
const machineKey = ({ suite, machine }: Baseline) => `${fullName(suite)}/${machine}`

/** A selected test of a baseline whose machine lists it, whose samples a query loads. */
interface Line {
  /** The baseline's position among the baselines. */
  at: number
  test: string
}

/**
 * What is known of `baselines` (GR9), given the suites, once they are listed, the metric plotted
 * and the tests selected: whether each is usable, its commit's display value, and its samples.
 * The states are the same array from one render to the next until one of them changes.
 *
 * A baseline is checked as a commit given to a commit picker is (AR15; see `useCheckedCommits`).
 * Once its machine is known to exist, the tests that machine lists for the metric are listed, as
 * for the traces (see api/tests.ts), and the samples of each selected test listed are fetched on
 * their own, since the API refuses a test that does not exist (E9). Everything is kept for as long
 * as the page is open (GR8; see `forgetBaselines`).
 */
export function useBaselines(
  baselines: readonly Baseline[],
  suites: readonly Suite[] | undefined,
  metric: Metric | undefined,
  selected: ReadonlySet<string>,
): Baselines {
  const checked = useCheckedCommits(baselines, suites)
  const name = metric?.name ?? ''

  // Without waiting for the commit to be looked up: a commit the machine has no run at gives no
  // samples rather than an error (E9), and its baseline is then dropped (AR2 "State").
  const drawable = useMemo(
    () =>
      checked.states.map(
        ({ schema, machineKnown, found }) =>
          metric !== undefined &&
          schema !== undefined &&
          machineKnown === true &&
          found !== false &&
          declares(schema, metric),
      ),
    [checked.states, metric],
  )

  // The tests of each machine of a baseline drawn, listed once however many baselines it has.
  const machines = useMemo(() => {
    const drawn = new Map<string, Baseline>()
    baselines.forEach((baseline, i) => {
      if (drawable[i]) drawn.set(machineKey(baseline), baseline)
    })
    return [...drawn.values()]
  }, [baselines, drawable])
  const lists = useQueries({
    queries: machines.map(({ suite, machine }) => keptTestNamesQuery(suite, machine, name)),
    combine: combineResults,
  })
  const listed = useMemo(() => {
    const held = new Map<string, ReadonlySet<string>>()
    machines.forEach((baseline, i) => {
      const list = lists.data[i]
      if (list !== undefined) held.set(machineKey(baseline), new Set(list.names))
    })
    return held
  }, [machines, lists.data])

  const lines = useMemo(
    () =>
      baselines.flatMap((baseline, at): Line[] => {
        const held = drawable[at] ? listed.get(machineKey(baseline)) : undefined
        if (held === undefined) return []
        return [...selected].filter((test) => held.has(test)).map((test) => ({ at, test }))
      }),
    [baselines, drawable, listed, selected],
  )
  const samples = useQueries({
    queries: lines.map(({ at, test }) => {
      const baseline = baselines[at]
      const { suite, machine, commit } = baseline
      return {
        queryKey: [...queryKeys.baselines(suite), machine, commit, name, test],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          fetchSamples(baseline, name, test, signal),
        staleTime: Infinity,
        gcTime: Infinity,
        // Samples are read whole, never compared with previous ones.
        structuralSharing: false,
      }
    }),
    combine: combineResults,
  })
  // The samples of each baseline, by test: those of the tests that have some, the only ones a
  // baseline draws a line for (GR9).
  const byBaseline = useMemo(() => {
    const maps = baselines.map(() => new Map<string, Measurement[]>())
    samples.data.forEach((data, i) => {
      const { at, test } = lines[i]
      if (data !== undefined && data.length > 0) maps[at].set(test, data)
    })
    return maps
  }, [baselines, lines, samples.data])

  const states = useMemo(
    () =>
      baselines.map((baseline, i): BaselineState => {
        const suiteLabel = fullLabelOf(suites, baseline.suite)
        const { display, unusable } = checked.states[i]
        return {
          baseline,
          suiteLabel,
          display,
          label: joinLabels(suiteLabel, baseline.machine, display),
          unusable,
          samples: drawable[i] ? byBaseline[i] : undefined,
        }
      }),
    [baselines, suites, checked.states, drawable, byBaseline],
  )
  return {
    states,
    error: checked.error ?? lists.error ?? samples.error,
    retry: () => [checked, lists, samples].forEach((group) => group.retry()),
  }
}

/** The baselines named by the URL's `values`, each parsed once. */
export function useParsedBaselines(values: readonly string[]): Baseline[] {
  return useMemo(() => values.flatMap((value) => parseBaseline(value) ?? []), [values])
}

/**
 * Forget the baselines' data that nothing shows, and the lists of their machines' tests, which the
 * Graph page keeps for as long as it is open (GR8), once it has left.
 */
export function forgetBaselines(client: QueryClient): void {
  forgetEverySuiteLater(client, queryKeys.baselines)
  forgetEverySuiteLater(client, queryKeys.tests)
}
