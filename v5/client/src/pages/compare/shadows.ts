/**
 * The shadows (CP8): sides B pinned, which the URL holds as `shadow` (see shadow-specs.ts), and
 * which the chart overlays as lines. This reads them -- checks them against what the API holds,
 * lists their runs and loads their selected runs' samples -- pins and dismisses them, and computes
 * their lines. `ShadowStatus` shows their chips.
 */

import { useEffect, useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import type { Failures } from '../../api/failures'
import { commitRunsQuery, runRefKey, uniqueRuns, useRunSamples } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCheckedCommits } from '../../components/checked-commits'
import { sameElements, useSameElements, useSameElementsEach } from '../../same-elements'
import type { Metric } from '../../schema'
import { chartBars, type Bar } from './chart'
import {
  compareRows,
  sideSamples,
  sideValues,
  type ComparisonRow,
  type NoiseSettings,
} from './comparison'
import { hasFailed, sidesRuns } from './loading'
import { offeredMetrics } from './metrics'
import { runsParam, selectedRuns } from './run-selection'
import type { Settings } from './settings'
import { formatShadow, MAX_SHADOWS, shadowOf, uniqueShadows, type ShadowSpec } from './shadow-specs'
import { samplesOfRuns, type Comparison } from './use-comparison'
import type { Side } from './use-side'

type Run = Schemas['Run']
type Sample = Schemas['Sample']

/** What is known of a shadow. */
export interface ShadowState {
  /** As the URL spells it, which tells it apart from the other shadows. */
  key: string
  /** Its suite, once the suites are known to hold it. */
  schema: SuiteSchema | undefined
  /** What names it, on its chip and in its points' tooltips (CP8). */
  label: string
  /** The samples of each of its selected runs, once they have all arrived. */
  runSamples: Sample[][] | undefined
}

export interface Shadows {
  shadows: ShadowState[]
  /** Why side B cannot be pinned as it is, if it cannot (CP8). */
  pinReason: string | undefined
  pin(): void
  dismiss(key: string): void
  /** What could not be loaded of the shadows (CP8 "Data"). */
  failures: Failures
}

/** A runs list, as far as the shadows go. */
interface RunList {
  data: Run[] | undefined
  error: Error | null
  refetch: () => unknown
}

/** The shadows' runs lists, the same array from one render to the next until one changes. */
const runLists = (results: RunList[]): RunList[] =>
  results.map(({ data, error, refetch }) => ({ data, error, refetch }))

/**
 * The shadows `specs`, which `update` changes, beside sides `a` and `b`, given the suites, once
 * they are listed.
 *
 * Each shadow is checked as a commit given to a commit picker is (AR15), and dropped once it is
 * known to be unusable (AR2 "State"); once its runs are listed, those it names that are not among
 * them are dropped, and it selects every run if none is left (as CP7 does for a side). Its runs'
 * samples are asked for once they are listed, apart from the sides', but a run they share is
 * fetched once.
 */
export function useShadows(
  specs: ShadowSpec[],
  { a, b }: { a: Side; b: Side },
  suites: readonly SuiteSchema[] | undefined,
  update: (changes: Partial<Settings>) => void,
): Shadows {
  const keys = useMemo(() => specs.map(formatShadow), [specs])
  const checked = useCheckedCommits(specs, suites)
  const lists = useQueries({
    queries: specs.map(({ suite, machine, commit }) => commitRunsQuery(suite, machine, commit)),
    combine: runLists,
  })

  // Each shadow's runs, once listed, those it selects, and those by `runRefKey`, in their order.
  const runs = useMemo(
    () =>
      specs.map((spec, i) => {
        const uuids = lists[i].data?.map((run) => run.uuid)
        const selected = selectedRuns(uuids, spec.runs, false)
        const refs = (uuids ?? []).map((uuid) => ({ suite: spec.suite, uuid }))
        const chosen = refs.filter(({ uuid }) => selected?.has(uuid)).map(runRefKey)
        return { uuids, selected, refs, chosen }
      }),
    [specs, lists],
  )

  // Every rewrite of the shadows lands here, in one change, since each rewrites the whole list.
  useEffect(() => {
    const kept = specs.flatMap((spec, i) => {
      if (checked.states[i].unusable) return []
      const { uuids, selected } = runs[i]
      return uuids && selected ? [shadowOf({ ...spec, runs: runsParam(uuids, selected) })] : [spec]
    })
    const next = uniqueShadows(kept)
    if (!sameElements(next.map(formatShadow), keys)) update({ shadow: next })
  }, [specs, keys, checked.states, runs, update])

  const refs = useMemo(() => uniqueRuns(...runs.map((entry) => entry.refs)), [runs])
  const wanted = useMemo(() => new Set(runs.flatMap((entry) => entry.chosen)), [runs])
  const states = useRunSamples(refs, wanted)

  const shadows = useMemo(
    () =>
      specs.map((spec, i): ShadowState => {
        const { schema, display } = checked.states[i]
        const { uuids, selected, chosen } = runs[i]
        const subset =
          spec.runs.length > 0 && uuids !== undefined && selected !== undefined
            ? ` (${selected.size} of ${uuids.length} runs)`
            : ''
        return {
          key: keys[i],
          schema,
          label: `${spec.suite}/${spec.machine}/${display}${subset}`,
          runSamples: samplesOfRuns(chosen, states),
        }
      }),
    [specs, keys, checked.states, runs, states],
  )

  const side = shadowOf(b.settings)
  const pinReason =
    specs.length >= MAX_SHADOWS
      ? `At most ${MAX_SHADOWS} shadows can be pinned.`
      : keys.includes(formatShadow(side))
        ? 'Side B is pinned already.'
        : undefined
  const pin = () => update({ shadow: [...specs, side] })
  const dismiss = (key: string) => update({ shadow: specs.filter((_, i) => keys[i] !== key) })

  // A runs list that fails for a machine that may not exist is not reported (AR2 "State"), and
  // the failures of the runs the sides select are reported as theirs.
  const ofSides = sidesRuns(a, b)
  const failedLists = lists.filter((list) => list.error !== null)
  const failedRuns = [...wanted]
    .filter((key) => !ofSides.has(key))
    .map((key) => states.get(key))
    .filter(hasFailed)
  const reported = lists.find((list, i) => list.error && checked.states[i].machineKnown)
  const failures: Failures = {
    error: checked.error ?? reported?.error ?? failedRuns[0]?.error ?? null,
    retry: () => {
      checked.retry()
      failedLists.forEach((list) => void list.refetch())
      failedRuns.forEach((state) => state.retry())
    },
  }

  return { shadows, pinReason, pin, dismiss, failures }
}

/** No noise knob enabled: the shadows' lines need no statuses. */
const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

/** A shadow's line: its points, sorted by their ratios, and what names it. */
export interface ShadowLine {
  label: string
  points: Bar[]
}

/**
 * The shadows' lines, a shadow's at its position among them: the tests the chart plots,
 * `plotted`, compared between side A, whose suite is `schemaA`, and the shadow, sorted by their
 * own ratios. A shadow draws nothing unless side A's suite and its own both offer `metric`.
 */
export function useShadowLines(
  shadows: readonly ShadowState[],
  schemaA: SuiteSchema | undefined,
  metric: Metric | undefined,
  { sample_agg: sampleAgg, run_agg: runAgg }: Pick<Settings, 'sample_agg' | 'run_agg'>,
  { tests, valuesA, biggerIsBetter }: Comparison,
  plotted: readonly ComparisonRow[],
): ShadowLine[] {
  const name = metric?.name
  // The samples of the shadows that can draw, the same arrays for as long as they hold the same
  // samples, so that their values are not computed again when only side A or B changes.
  const runSamples = useSameElementsEach(
    shadows.map((shadow) =>
      offeredMetrics(schemaA, shadow.schema).some((entry) => entry.name === name)
        ? shadow.runSamples
        : undefined,
    ),
  )
  const values = useMemo(
    () =>
      runSamples.map((samples) =>
        samples && name !== undefined
          ? sideValues(sideSamples(samples, name), sampleAgg, runAgg)
          : undefined,
      ),
    [runSamples, name, sampleAgg, runAgg],
  )
  const bars = useMemo(
    () =>
      values.map((ofShadow) =>
        tests && valuesA && ofShadow
          ? chartBars(compareRows(tests, valuesA, ofShadow, { biggerIsBetter, noise: NO_NOISE }))
          : [],
      ),
    [values, tests, valuesA, biggerIsBetter],
  )
  // The same for as long as the labels are, so that the chart is not drawn again whenever a run's
  // samples change state.
  const labels = useSameElements(shadows.map((shadow) => shadow.label))
  return useMemo(() => {
    const kept = new Set(plotted.map((row) => row.test))
    return labels.map((label, i) => ({
      label,
      points: bars[i].filter((bar) => kept.has(bar.test)),
    }))
  }, [labels, bars, plotted])
}
