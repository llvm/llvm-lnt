/**
 * The shadow (CP8): a side B pinned, which the URL holds like a side, under `*_shadow_b`, and which
 * the chart overlays as a line. It is read like a side, by `useSide`; this adds what is particular
 * to it: what dismisses it, pinning it, and the line it draws. `ShadowStatus` shows its chip.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { skipToken, useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Aggregation } from '../../aggregation'
import { useRunSamples, type SampleState } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { commitLookupKey, commitLookupQuery } from '../../components/commit-lookup'
import type { RowSelection } from '../../components/range-selection'
import { useSameElements } from '../../same-elements'
import type { Metric } from '../../schema'
import { useDropUnusable } from '../../url-state'
import { chartBars, type Bar } from './chart'
import { compareRows, type ComparisonRow, type NoiseSettings } from './comparison'
import { chosenRuns, hasFailed } from './loading'
import { offeredMetrics } from './metrics'
import {
  NO_SHADOW,
  PARAMS,
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
 * `selection`, whose clicks also call `onChange`: side A's runs, which dismiss the shadow when the
 * user changes them. Filling the selection from the URL, which the side does to the selection
 * itself, does not.
 */
function notifying(selection: RowSelection, onChange: () => void): RowSelection {
  return {
    ...selection,
    click: (key, shift) => {
      selection.click(key, shift)
      onChange()
    },
    setRows: (keys, select) => {
      selection.setRows(keys, select)
      onChange()
    },
  }
}

export interface Shadow {
  /** The shadow, read like a side. */
  side: Side
  /** How far the samples of its runs are loaded, by `runRefKey`. */
  states: ReadonlyMap<string, SampleState>
  /** Whether a shadow is pinned: whether the URL names its suite, machine and commit. */
  pinned: boolean
  /** Its commit's display value (AR6), or its commit string until that is known. */
  display: string
  /** Side A, whose changes by the user dismiss the shadow, but for its run aggregation. */
  sideA: Side
  /** Swap the sides, which dismisses the shadow. */
  swap(): void
  /** Pin side B as it is as the shadow, which gives the focus to its chip. */
  pin(): void
  dismiss(): void
  /** Those of its runs that the sides do not select, whose samples could not be loaded. */
  failed: SampleState[]
}

/**
 * The shadow, with the settings `all` gives it, which `update` changes, beside `sides`. Its samples
 * are asked for apart from the sides', but a run they share is fetched once. Once pinned, the
 * button dismissing it in `chipArea`, its chip, takes the focus. It is dropped, as AR2
 * says of a value that cannot be used (CP8), when:
 * - the URL names only part of it, as when `useSide` has dropped its suite or machine;
 * - its commit is not one of its machine's, as its picker found when side B held it;
 * - side A has no commit.
 */
export function useShadow(
  sides: Sides,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<SuiteSchema[]>,
  chipArea: RefObject<HTMLDivElement | null>,
): Shadow {
  const side = useSide('shadow_b', all, update, suites)
  const { a, b } = sides
  const { suite, machine, commit, runs, runAgg } = side.settings
  const pinned = side.named
  const named =
    suite !== '' ||
    machine !== '' ||
    commit !== '' ||
    runs.length > 0 ||
    runAgg !== PARAMS.run_agg_shadow_b.default
  const orphan = named && (!pinned || a.settings.commit === '')
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

  // Swapping the sides, or changing what side A is, dismisses the shadow. Changing side A's run
  // aggregation does not: the shadow follows it.
  const dismiss = useCallback(() => update(NO_SHADOW), [update])
  const updateA = useCallback(
    (changes: Partial<SideSettings>) =>
      update({
        ...sideChanges('a', changes),
        ...(pinned && Object.keys(changes).some((key) => key !== 'runAgg') ? NO_SHADOW : {}),
      }),
    [pinned, update],
  )
  const { selection: selectionA } = a
  const runsA = useMemo(
    () => (pinned ? notifying(selectionA, dismiss) : selectionA),
    [pinned, selectionA, dismiss],
  )
  const swap = () => {
    sides.swap()
    dismiss()
  }

  // Once the shadow is pinned, the button pinning it is gone: the focus goes to its chip's button
  // dismissing it.
  const justPinned = useRef(false)
  useEffect(() => {
    if (!pinned || !justPinned.current) return
    justPinned.current = false
    chipArea.current?.querySelector('button')?.focus()
  }, [pinned, chipArea])
  const pin = () => {
    justPinned.current = true
    update(sideChanges('shadow_b', b.settings))
  }

  // The failures of the runs the sides select are reported as theirs.
  const ofSides = new Set([...chosenRuns(a), ...chosenRuns(b)])
  const failed = chosenRuns(side)
    .filter((key) => !ofSides.has(key))
    .map((key) => states.get(key))
    .filter(hasFailed)

  return {
    side,
    states,
    pinned,
    display: lookup.data?.text ?? commit,
    sideA: { ...a, update: updateA, selection: runsA },
    swap,
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
  a: Side,
  metric: Metric | undefined,
  sampleAgg: Aggregation,
  { tests, valuesA, biggerIsBetter }: Comparison,
  plotted: readonly ComparisonRow[],
): Bar[] {
  const { side, states, pinned } = shadow
  const offered = useMemo(
    () => offeredMetrics(a.schema, side.schema).some((entry) => entry.name === metric?.name),
    [a.schema, side.schema, metric?.name],
  )
  const { values } = useSideComparison(
    side,
    states,
    offered ? metric?.name : undefined,
    sampleAgg,
  )
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
