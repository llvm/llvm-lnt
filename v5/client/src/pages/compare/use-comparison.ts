/**
 * The comparison of the Compare page's two sides (CP2 "Computation Reference"), from their selected
 * runs' samples, each step computed again only when what it depends on changes (see
 * comparison.ts).
 */

import { useMemo } from 'react'
import type { Schemas } from '../../api/client'
import type { SampleState } from '../../api/runs'
import { useSameElements } from '../../same-elements'
import type { Metric } from '../../schema'
import {
  compareRows,
  joinSides,
  sideSamples,
  sideValues,
  type ComparedTest,
  type ComparisonRow,
} from './comparison'
import { chosenRuns } from './loading'
import { noiseSettings, type Settings } from './settings'
import type { Side, Sides } from './use-side'

type Sample = Schemas['Sample']

const NO_ROWS: ComparisonRow[] = []

/**
 * The samples of each of the runs `side` has selected, in the order they were measured, once they
 * have all arrived. With no run selected, there is nothing to compare, rather than nothing compared.
 */
function useRunSamplesOf(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
): Sample[][] | undefined {
  const chosen = chosenRuns(side)
  return useMemo(() => {
    if (chosen.length === 0) return undefined
    const samples = chosen.map((key) => states.get(key)?.samples)
    return samples.every((entry) => entry !== undefined) ? samples : undefined
  }, [chosen, states])
}

/**
 * The side's samples for each test, once its selected runs' samples have arrived and `metric` is
 * known, and its value of each, with the aggregations `settings` holds. The samples are the same
 * for as long as the side's runs' are, so that they are not combined again when only another
 * side's change.
 */
export function useSideComparison(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
  metric: string | undefined,
  { sample_agg: sampleAgg, run_agg: runAgg }: Pick<Settings, 'sample_agg' | 'run_agg'>,
) {
  const runSamples = useSameElements(useRunSamplesOf(side, states))
  const samples = useMemo(
    () => (runSamples && metric !== undefined ? sideSamples(runSamples, metric) : undefined),
    [runSamples, metric],
  )
  const values = useMemo(
    () => samples && sideValues(samples, sampleAgg, runAgg),
    [samples, sampleAgg, runAgg],
  )
  return { samples, values }
}

export interface Comparison {
  /** The tests of the comparison, once both sides' samples have arrived and a metric is chosen. */
  tests: ComparedTest[] | undefined
  /** Their rows, or none until then. */
  rows: ComparisonRow[]
  /** Side A's value of each test, which the shadow is compared with too (CP8). */
  valuesA: ReadonlyMap<string, number> | undefined
  biggerIsBetter: boolean
}

/** The comparison of sides `a` and `b` for `metric`, with the page's `settings`. */
export function useComparison(
  { a, b, states }: Pick<Sides, 'a' | 'b' | 'states'>,
  metric: Metric | undefined,
  settings: Settings,
): Comparison {
  const sideA = useSideComparison(a, states, metric?.name, settings)
  const sideB = useSideComparison(b, states, metric?.name, settings)
  const { samples: samplesA, values: valuesA } = sideA
  const { samples: samplesB, values: valuesB } = sideB
  const tests = useMemo(
    () => (samplesA && samplesB ? joinSides(samplesA, samplesB) : undefined),
    [samplesA, samplesB],
  )
  const biggerIsBetter = metric?.bigger_is_better ?? false
  const { pct, pval, floor } = noiseSettings(settings)
  const rows = useMemo(
    () =>
      tests && valuesA && valuesB
        ? compareRows(tests, valuesA, valuesB, { biggerIsBetter, noise: { pct, pval, floor } })
        : NO_ROWS,
    [tests, valuesA, valuesB, biggerIsBetter, pct, pval, floor],
  )
  return { tests, rows, valuesA, biggerIsBetter }
}
