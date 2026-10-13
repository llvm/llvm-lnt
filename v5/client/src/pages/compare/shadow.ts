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
import type { RowSelection } from '../../components/range-selection'
import { useSameElements } from '../../same-elements'
import type { Metric } from '../../schema'
import { useDropUnusable } from '../../url-state'
import { chartBars, type Bar } from './chart'
import { compareRows, type ComparisonRow, type NoiseSettings } from './comparison'
import { chosenRuns, hasFailed, sidesRuns } from './loading'
import { offeredMetrics } from './metrics'
import {
  NO_SHADOW,
  sideChanges,
  type Settings,
  type SideSettings,
} from './settings'
import { useSideComparison, type Comparison } from './use-comparison'
import { useSide, type Side, type Sides } from './use-side'

const NO_BARS: Bar[] = []
/** No noise knob enabled: the shadow's line needs no statuses. */
const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

/**
 * `selection`, every change through which also calls `onChange`: side A's runs, which dismiss the
 * shadow when the user changes them from the side's panel. The side filling its selection from the
 * URL, which it does through the selection itself rather than this one, does not.
 */
function notifying(selection: RowSelection, onChange: () => void): RowSelection {
  // Each member listed, so that one added to RowSelection is a choice to make here.
  return {
    subscribe: selection.subscribe,
    selected: selection.selected,
    limit: selection.limit,
    inverted: selection.inverted,
    click: (key, shift) => {
      selection.click(key, shift)
      onChange()
    },
    setRows: (keys, select) => {
      selection.setRows(keys, select)
      onChange()
    },
    replace: (keys) => {
      selection.replace(keys)
      onChange()
    },
  }
}

export interface Shadow {
  /** The shadow, read like a side. */
  side: Side
  /** How far the samples of its runs are loaded, by `runRefKey`, for its line. */
  states: ReadonlyMap<string, SampleState>
  /** Whether a shadow is pinned: whether the URL names its suite, machine and commit. */
  pinned: boolean
  /** Its commit's display value (AR6), or its commit string until that is known. */
  display: string
  /**
   * Side A, as its panel changes it: any change by the user to what side A is dismisses the shadow.
   */
  dismissingA: Side
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

  // Changing what side A is dismisses the shadow; so does swapping the sides, which the page does.
  const dismiss = useCallback(() => update(NO_SHADOW), [update])
  const updateA = useCallback(
    (changes: Partial<SideSettings>) =>
      update({
        ...sideChanges('a', changes),
        ...(pinned ? NO_SHADOW : {}),
      }),
    [pinned, update],
  )
  const { selection: selectionA } = a
  const runsA = useMemo(
    () => (pinned ? notifying(selectionA, dismiss) : selectionA),
    [pinned, selectionA, dismiss],
  )
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
    dismissingA: { ...a, update: updateA, selection: runsA },
    pin,
    dismiss,
    failed,
  }
}

/**
 * The shadow's line: the tests the chart plots, `plotted`, compared between side A and the shadow,
 * sorted by their own ratios. Nothing unless side A's suite and the shadow's both offer `metric`.
 * Every test's point is computed once, and those of the tests the chart plots kept, the same for as
 * long as they are the same, as the noise is classified anew.
 */
export function useShadowLine(
  shadow: Shadow,
  metric: Metric | undefined,
  settings: Settings,
  { tests, valuesA, biggerIsBetter }: Comparison,
  plotted: readonly ComparisonRow[],
): Bar[] {
  const { side, states, pinned } = shadow
  const schemaA = shadow.dismissingA.schema
  const offered = useMemo(
    () => offeredMetrics(schemaA, side.schema).some((entry) => entry.name === metric?.name),
    [schemaA, side.schema, metric?.name],
  )
  const { values } = useSideComparison(side, states, offered ? metric?.name : undefined, settings)
  const bars = useMemo(
    () =>
      pinned && tests && valuesA && values
        ? chartBars(compareRows(tests, valuesA, values, { biggerIsBetter, noise: NO_NOISE }))
        : NO_BARS,
    [pinned, tests, valuesA, values, biggerIsBetter],
  )
  return useSameElements(
    useMemo(() => {
      if (bars.length === 0) return NO_BARS
      const kept = new Set(plotted.map((row) => row.test))
      return bars.filter((bar) => kept.has(bar.test))
    }, [bars, plotted]),
  )
}
