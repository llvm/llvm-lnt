/**
 * The shadow (CP8): a side B pinned, which the URL holds like a side, under `*_shadow_b`, and which
 * the chart overlays as a line. It is read like a side, by `useSide`; this adds what is particular
 * to it: what dismisses it, pinning it, and the line it draws. `ShadowStatus` shows its chip.
 */

import { useCallback, useEffect, useMemo } from 'react'
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query'
import { useRunSamples, type SampleState } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { commitLookupKey, commitLookupQuery } from '../../components/commit-lookup'
import type { Metric } from '../../schema'
import { useDropUnusable } from '../../url-state'
import { chartBars, type Bar } from './chart'
import { compareRows, type ComparisonRow, type NoiseSettings } from './comparison'
import { chosenRuns, hasFailed, sidesRuns } from './loading'
import { offeredMetrics } from './metrics'
import { NO_SHADOW, sideChanges, type Settings } from './settings'
import { useSideComparison, type Comparison } from './use-comparison'
import { useSide, type Side, type Sides } from './use-side'

const NO_BARS: Bar[] = []
/** No noise knob enabled: the shadow's line needs no statuses. */
const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

export interface Shadow {
  /** The shadow, read like a side. */
  side: Side
  /** How far the samples of its runs are loaded, by `runRefKey`, for its line. */
  states: ReadonlyMap<string, SampleState>
  /** Whether a shadow is pinned: whether the URL names its suite, machine and commit. */
  pinned: boolean
  /** Its commit's display value (AR6), or its commit string until that is known. */
  display: string
  /** Side A's suite, which the shadow is compared with. */
  schemaA: SuiteSchema | undefined
  /** Pin side B as it is as the shadow. */
  pin(): void
  dismiss(): void
  /** Those of its runs that the sides do not select, whose samples could not be loaded. */
  failed: SampleState[]
}

/**
 * The shadow, with the settings `all` gives it, which `update` changes, beside sides `a` and `b`.
 * Its samples are asked for apart from the sides', but a run they share is fetched once. It is
 * dropped, as AR2 says of a value that cannot be used (CP8), when:
 * - the URL names only part of it, as when `useSide` has dropped its suite or machine;
 * - its commit is not one of its machine's, as its picker found when side B held it;
 * - side A has no commit.
 */
export function useShadow(
  { a, b }: Pick<Sides, 'a' | 'b'>,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<SuiteSchema[]>,
): Shadow {
  const side = useSide('shadow_b', all, update, suites)
  const { suite, machine, commit, runs } = side.settings
  const pinned = side.named
  const partlyNamed = suite !== '' || machine !== '' || commit !== '' || runs.length > 0
  const orphan = partlyNamed && (!pinned || a.settings.commit === '')
  useEffect(() => {
    if (orphan) update(NO_SHADOW)
  }, [orphan, update])

  // Looked up as side B's commit picker looked it up, whose answer it shares.
  const { schema } = side
  const lookup = useQuery({
    queryKey: commitLookupKey(suite, { machine }, commit),
    queryFn:
      pinned && schema !== undefined
        ? commitLookupQuery(schema, { machine }, commit).queryFn
        : skipToken,
  })
  useDropUnusable(
    lookup,
    (found) => found !== null,
    () => update(NO_SHADOW),
  )

  const wanted = useMemo(() => new Set(side.wanted), [side.wanted])
  const states = useRunSamples(side.refs, wanted)

  // Side A's changes, and swapping the sides, dismiss the shadow too (see `useSides`).
  const dismiss = useCallback(() => update(NO_SHADOW), [update])
  const pin = () => update(sideChanges('shadow_b', b.settings))

  // The failures of the runs the sides select are reported as theirs.
  const ofSides = sidesRuns(a, b)
  const failed = chosenRuns(side)
    .filter((key) => !ofSides.has(key))
    .map((key) => states.get(key))
    .filter(hasFailed)

  return {
    side,
    states,
    pinned,
    display: lookup.data?.text ?? commit,
    schemaA: a.schema,
    pin,
    dismiss,
    failed,
  }
}

/**
 * The shadow's line: the tests the chart plots, `plotted`, compared between side A and the shadow,
 * sorted by their own ratios. Nothing unless side A's suite and the shadow's both offer `metric`.
 */
export function useShadowLine(
  shadow: Shadow,
  metric: Metric | undefined,
  aggregations: Pick<Settings, 'sample_agg' | 'run_agg'>,
  { tests, valuesA, biggerIsBetter }: Comparison,
  plotted: readonly ComparisonRow[],
): Bar[] {
  const { side, states, pinned } = shadow
  const { schemaA } = shadow
  const offered = useMemo(
    () => offeredMetrics(schemaA, side.schema).some((entry) => entry.name === metric?.name),
    [schemaA, side.schema, metric?.name],
  )
  const { values } = useSideComparison(side, states, offered ? metric?.name : undefined, aggregations)
  const bars = useMemo(
    () =>
      pinned && tests && valuesA && values
        ? chartBars(compareRows(tests, valuesA, values, { biggerIsBetter, noise: NO_NOISE }))
        : NO_BARS,
    [pinned, tests, valuesA, values, biggerIsBetter],
  )
  return useMemo(() => {
    if (bars.length === 0) return NO_BARS
    const kept = new Set(plotted.map((row) => row.test))
    return bars.filter((bar) => kept.has(bar.test))
  }, [bars, plotted])
}
