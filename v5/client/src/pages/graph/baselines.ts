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
  /** The label of its machine (AR23), or its name until its suite's machines are listed. */
  machineLabel: string
  /** The display value of its commit, or the commit string until it is known. */
  display: string
  /**
   * How it is named: its suite's full label, its machine's label and its commit's display value
   * (GR9).
   */
  label: string
  /**
   * Whether it is known to be unusable: its suite, its machine or its commit does not exist, or
   * the machine has no run at the commit (AR2 "State").
   */
  unusable: boolean
  /**
   * Its samples, by metric, then by test, of the selected tests whose samples have all arrived,
   * for each metric plotted it is known to be drawn for: it draws nothing in the panel of a metric
   * its suite does not declare as one with the same meaning (GR9).
   */
  samples: ReadonlyMap<string, ReadonlyMap<string, Measurement[]>>
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

const NO_METRICS: string[] = []

/** A baseline's machine, as a key. */
const machineKey = ({ suite, machine }: Baseline) => `${fullName(suite)}/${machine}`

/** The list of the tests of a baseline's machine for `metric`, as a key. */
const listKey = (baseline: Baseline, metric: string) => `${machineKey(baseline)}\0${metric}`

/**
 * A selected test of a baseline whose machine lists it for a metric it is drawn for, whose samples
 * a query loads.
 */
interface Line {
  /** The baseline's position among the baselines. */
  at: number
  metric: string
  test: string
}

/**
 * What is known of `baselines` (GR9), given the suites, once they are listed, the metrics plotted
 * and the tests selected: whether each is usable, its commit's display value, and its samples.
 * The states are the same array from one render to the next until one of them changes.
 *
 * A baseline is checked as a commit given to a commit picker is (AR15; see `useCheckedCommits`).
 * Once its machine is known to exist, the tests that machine lists for each metric the baseline is
 * drawn for are listed, as for the traces (see api/tests.ts), and the samples of each selected test
 * listed are fetched on their own, since the API refuses a test that does not exist (E9).
 * Everything is kept for as long as the page is open (GR8; see `forgetBaselines`).
 */
export function useBaselines(
  baselines: readonly Baseline[],
  suites: readonly Suite[] | undefined,
  metrics: readonly Metric[],
  selected: ReadonlySet<string>,
): Baselines {
  const checked = useCheckedCommits(baselines, suites)

  // The names of the metrics each baseline is drawn for: none until its machine is known to exist.
  // Without waiting for the commit to be looked up: a commit the machine has no run at gives no
  // samples rather than an error (E9), and its baseline is then dropped (AR2 "State").
  const drawnFor = useMemo(
    () =>
      checked.states.map(({ schema, machineKnown, found }) =>
        schema !== undefined && machineKnown === true && found !== false
          ? metrics.filter((metric) => declares(schema, metric)).map((metric) => metric.name)
          : NO_METRICS,
      ),
    [checked.states, metrics],
  )

  // The tests of each machine of a baseline drawn, for each metric it is drawn for, listed once
  // however many baselines it has.
  const machines = useMemo(() => {
    const drawn = new Map<string, { baseline: Baseline; metric: string }>()
    baselines.forEach((baseline, i) => {
      for (const metric of drawnFor[i]) {
        drawn.set(listKey(baseline, metric), { baseline, metric })
      }
    })
    return [...drawn.values()]
  }, [baselines, drawnFor])
  const lists = useQueries({
    queries: machines.map(({ baseline, metric }) =>
      keptTestNamesQuery(baseline.suite, baseline.machine, metric),
    ),
    combine: combineResults,
  })
  const listed = useMemo(() => {
    const held = new Map<string, ReadonlySet<string>>()
    machines.forEach(({ baseline, metric }, i) => {
      const list = lists.data[i]
      if (list !== undefined) held.set(listKey(baseline, metric), new Set(list.names))
    })
    return held
  }, [machines, lists.data])

  const lines = useMemo(
    () =>
      baselines.flatMap((baseline, at): Line[] =>
        drawnFor[at].flatMap((metric) => {
          const held = listed.get(listKey(baseline, metric))
          if (held === undefined) return []
          const tests = [...selected].filter((test) => held.has(test))
          return tests.map((test) => ({ at, metric, test }))
        }),
      ),
    [baselines, drawnFor, listed, selected],
  )
  const samples = useQueries({
    queries: lines.map(({ at, metric, test }) => {
      const baseline = baselines[at]
      const { suite, machine, commit } = baseline
      return {
        queryKey: [...queryKeys.baselines(suite), machine, commit, metric, test],
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          fetchSamples(baseline, metric, test, signal),
        staleTime: Infinity,
        gcTime: Infinity,
        // Samples are read whole, never compared with previous ones.
        structuralSharing: false,
      }
    }),
    combine: combineResults,
  })
  // The samples of each baseline, by metric it is drawn for, then by test: those of the tests that
  // have some, the only ones a baseline draws a line for (GR9).
  const byBaseline = useMemo(() => {
    const maps = drawnFor.map(
      (names) => new Map(names.map((metric) => [metric, new Map<string, Measurement[]>()])),
    )
    samples.data.forEach((data, i) => {
      const { at, metric, test } = lines[i]
      if (data !== undefined && data.length > 0) maps[at].get(metric)!.set(test, data)
    })
    return maps
  }, [drawnFor, lines, samples.data])

  const states = useMemo(
    () =>
      baselines.map((baseline, i): BaselineState => {
        const suiteLabel = fullLabelOf(suites, baseline.suite)
        const { machineLabel, display, unusable } = checked.states[i]
        return {
          baseline,
          suiteLabel,
          machineLabel,
          display,
          label: joinLabels(suiteLabel, machineLabel, display),
          unusable,
          samples: byBaseline[i],
        }
      }),
    [baselines, suites, checked.states, byBaseline],
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
