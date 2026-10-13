import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import { useSuites } from '../../api/suites'
import { ChipList } from '../../components/chip-list'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import type { RowSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { useSameElements } from '../../same-elements'
import { labelOf } from '../../schema'
import { useUrlState, useVisitKey } from '../../url-state'
import { ValueStore } from '../../value-store'
import {
  compareRows,
  type ComparisonRow,
  type NoiseKnob,
  type NoiseSettings,
} from './comparison'
import { AddToRegression } from './add-to-regression'
import { chartBars, SHADOW_COLOR, type Bar } from './chart'
import { ColumnsMenu } from './columns-menu'
import { chosenRuns, loadProgress, missingInput, runCount } from './loading'
import { offeredMetrics, useMetric } from './metrics'
import { CompareChart } from './compare-chart'
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import {
  NO_SHADOW,
  NOISE_PARAMS,
  noiseSettings,
  PARAMS,
  sideChanges,
  type SideSettings,
} from './settings'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useComparison, useSideComparison } from './use-comparison'
import { useComparisonTable } from './use-comparison-table'
import { useProfileLinks } from './use-profile-links'
import { useShadow } from './use-shadow'
import { runsListFailed, useSides } from './use-side'
import styles from './compare.module.css'

const NO_BARS: Bar[] = []
/** No noise knob enabled: the shadow's line needs no statuses. */
const NO_NOISE: NoiseSettings = { pct: null, pval: null, floor: null }

const testOf = (row: ComparisonRow) => row.test

/**
 * The Compare page (CP1-CP7), started afresh whenever the user navigates to it -- a link to another
 * comparison while on this one, say -- so that it shows what the new URL names.
 */
export default function Compare() {
  return <ComparePage key={useVisitKey()} />
}

/**
 * `selection`, whose clicks also call `onChange`: side A's runs, which dismiss the shadow when the
 * user changes them (CP8). Filling the selection from the URL, which the side does to the
 * selection itself, does not.
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

function ComparePage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  // The test whose row is hovered in the table, and the one whose bar is hovered on the chart (CP5).
  const [emphasis] = useState(() => new ValueStore<string | null>(null))
  const [hovered] = useState(() => new ValueStore<string | null>(null))
  const sides = useSides(settings, update, suites)
  const { a, b, shadow: shadowSide, swapped, states } = sides
  const shadow = useShadow(shadowSide, a.settings.commit, update)

  const { offered, metric } = useMetric(a, b, settings, update, suites)

  const profiles = useProfileLinks(a, b)

  const comparison = useComparison(sides, metric, settings)
  const { tests, valuesA, biggerIsBetter, noise } = comparison
  // The shadow's values, unless side A's suite and the shadow's do not both offer the metric, in
  // which case the shadow draws nothing (CP8).
  const shadowOffered = useMemo(
    () => offeredMetrics(a.schema, shadowSide.schema).some((entry) => entry.name === metric?.name),
    [a.schema, shadowSide.schema, metric?.name],
  )
  const shadowMetric = shadowOffered ? metric?.name : undefined
  const { values: valuesShadow } = useSideComparison(
    shadowSide,
    states,
    shadowMetric,
    settings.sample_agg,
  )
  const table = useComparisonTable(comparison, settings, update, profiles.links)
  const { plotted } = table
  // The shadow's line (CP8): the tests the chart plots, compared between side A and the shadow,
  // sorted by their own ratios. Every test's point is computed once, and those of the tests the
  // chart plots kept, the same for as long as they are the same, as the noise is classified anew.
  const shadowBars = useMemo(
    () =>
      shadow.pinned && tests && valuesA && valuesShadow
        ? chartBars(compareRows(tests, valuesA, valuesShadow, { biggerIsBetter, noise: NO_NOISE }))
        : NO_BARS,
    [shadow.pinned, tests, valuesA, valuesShadow, biggerIsBetter],
  )
  const shadowPoints = useSameElements(
    useMemo(() => {
      if (shadowBars.length === 0) return NO_BARS
      const kept = new Set(plotted.map(testOf))
      return shadowBars.filter((bar) => kept.has(bar.test))
    }, [shadowBars, plotted]),
  )

  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [NOISE_PARAMS[knob]]: value }),
    [update],
  )

  // Swapping the sides, or changing what side A is, dismisses the shadow (CP8). Changing side A's
  // run aggregation does not: the shadow follows it.
  const swap = () => {
    sides.swap()
    update(NO_SHADOW)
  }
  const { pinned } = shadow
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
    () => (pinned ? notifying(selectionA, () => update(NO_SHADOW)) : selectionA),
    [pinned, selectionA, update],
  )
  // Once the shadow is pinned, the button pinning it is gone: the focus goes to its chip's button
  // dismissing it. Once dismissed, it goes back to the button pinning another.
  const pinButton = useRef<HTMLButtonElement>(null)
  const chipArea = useRef<HTMLDivElement>(null)
  const justPinned = useRef(false)
  useEffect(() => {
    if (!pinned || !justPinned.current) return
    justPinned.current = false
    chipArea.current?.querySelector('button')?.focus()
  }, [pinned])
  const pin = () => {
    justPinned.current = true
    update(sideChanges('shadow_b', b.settings))
  }

  const { chosen, loaded, failed, shadowFailed } = loadProgress(a, b, shadowSide, states)
  const missing = suites.isPending ? null : missingInput(a, b, offered.length, metric !== undefined)
  return (
    <section>
      <h1>Compare</h1>
      {suites.isError && (
        <ErrorMessage
          context="The test suites could not be listed"
          error={suites.error}
          onRetry={() => void suites.refetch()}
        />
      )}
      <div className={styles.sides}>
        <SidePanel
          side={{ ...a, update: updateA, selection: runsA }}
          title="Side A (Baseline)"
          suites={suites.data ?? []}
        />
        <button
          type="button"
          className={styles.swap}
          aria-label="Swap sides"
          title="Swap sides"
          onClick={swap}
        >
          ⇄
        </button>
        <SidePanel
          side={b}
          title="Side B (New)"
          suites={suites.data ?? []}
          action={
            tests !== undefined &&
            !pinned && (
              <button type="button" ref={pinButton} onClick={pin}>
                Pin as shadow
              </button>
            )
          }
        />
      </div>
      <ControlsPanel>
        <div className={styles.settings}>
          {a.schema === undefined && b.schema === undefined ? (
            <p className={styles.note}>Select a suite to load metrics...</p>
          ) : offered.length === 0 ? (
            <p className={styles.note}>No metric can be compared.</p>
          ) : (
            <Select
              label="Metric"
              options={offered.map((entry) => ({ value: entry.name, label: labelOf(entry) }))}
              value={metric?.name ?? null}
              placeholder="-- Select metric --"
              onChange={(value) => update({ metric: value })}
            />
          )}
          <Select<Aggregation>
            label="Sample aggregation"
            options={AGGREGATION_OPTIONS}
            value={settings.sample_agg}
            onChange={(value) => update({ sample_agg: value })}
          />
          <RegexFilter
            filter={table.filter}
            label="Filter tests"
            placeholder="Filter tests..."
            regex={settings.test_filter_regex}
            onRegexChange={(regex) => update({ test_filter_regex: regex })}
          />
          <NoiseControls
            noise={noiseSettings(settings)}
            onNoise={onNoise}
            hideNoise={settings.hide_noise}
            onHideNoise={(hide) => update({ hide_noise: hide })}
          />
        </div>
        <AddToRegression
          suite={b.settings.suite}
          machine={b.settings.machine}
          commit={b.settings.commit}
          metric={metric?.name ?? ''}
          rows={tests === undefined ? undefined : plotted}
          swapped={swapped}
        />
      </ControlsPanel>
      {failed.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failed.length)} could not be loaded`}
          error={failed[0].error}
          onRetry={() => failed.forEach((state) => state.retry())}
        />
      )}
      {runsListFailed(shadowSide) && (
        <ErrorMessage
          context="The shadow's runs could not be listed"
          error={shadowSide.runs.error}
          onRetry={() => void shadowSide.runs.refetch()}
        />
      )}
      {shadowFailed.length > 0 && (
        <ErrorMessage
          context={
            `The samples of ${runCount(shadowFailed.length)} of the shadow could not be loaded`
          }
          error={shadowFailed[0].error}
          onRetry={() => shadowFailed.forEach((state) => state.retry())}
        />
      )}
      <div ref={chipArea}>
        <ChipList
          label="Shadow"
          chips={
            pinned
              ? [
                  {
                    key: 'shadow',
                    mark: (
                      <span
                        className={styles.shadowMark}
                        style={{ background: SHADOW_COLOR }}
                        aria-hidden="true"
                      />
                    ),
                    text: `Shadow: ${shadow.display} on ${shadowSide.settings.machine}`,
                  },
                ]
              : []
          }
          removeLabel={() => 'Dismiss the shadow'}
          onRemove={() => update(NO_SHADOW)}
          focusWhenEmpty={() => pinButton.current}
        />
      </div>
      {profiles.failure.error !== null && (
        <ErrorMessage
          context="The profiles could not be listed"
          error={profiles.failure.error}
          onRetry={profiles.failure.retry}
        />
      )}
      {suites.isPending ? (
        <Loading />
      ) : missing !== null ? (
        <p className={styles.note}>{missing}</p>
      ) : failed.length > 0 || a.runs.isError || b.runs.isError ? null : a.selected === undefined ||
        b.selected === undefined ? (
        <Loading label="Loading runs..." />
      ) : tests === undefined ? (
        <Loading label={`Loading samples: ${loaded} of ${chosen} runs...`} />
      ) : (
        <>
          <CompareChart
            rows={plotted}
            shadow={shadowPoints}
            noisePct={noise.pct}
            revision={[...chosenRuns(a), '|', ...chosenRuns(b), '|', metric?.name].join('\n')}
            emphasis={emphasis}
            hovered={hovered}
          />
          <SummaryBar counts={table.counts} />
          <CompareTable
            {...table.view}
            menu={
              <ColumnsMenu shown={table.optional} onChange={(keys) => update({ columns: keys })} />
            }
            links={profiles.links}
            hovered={hovered}
            emphasis={emphasis}
          />
        </>
      )}
    </section>
  )
}
