import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import { useSuites } from '../../api/suites'
import { ChipList } from '../../components/chip-list'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useRangeSelection, type RowSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings } from '../../format'
import { useSameElements } from '../../same-elements'
import { labelOf } from '../../schema'
import { useUrlState, useVisitKey } from '../../url-state'
import { ValueStore } from '../../value-store'
import {
  compareRows,
  geomeanRow,
  summaryCounts,
  type ComparisonRow,
  type NoiseSettings,
} from './comparison'
import { AddToRegression } from './add-to-regression'
import { chartBars, SHADOW_COLOR, type Bar } from './chart'
import { comparisonCsv, sortComparison, tableColumns } from './columns'
import { ColumnsMenu } from './columns-menu'
import { chosenRuns, loadProgress, missingInput, runCount } from './loading'
import { offeredMetrics, useMetric } from './metrics'
import { CompareChart } from './compare-chart'
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import {
  HIDDEN_IN_URL,
  NO_SHADOW,
  PARAMS,
  sideChanges,
  type SideSettings,
} from './settings'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useComparison, useSideComparison } from './use-comparison'
import { useProfileLinks } from './use-profile-links'
import { useShadow } from './use-shadow'
import { runsListFailed, useSides } from './use-side'
import styles from './compare.module.css'

const NO_TESTS: string[] = []
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
  const { tests, rows, valuesA, biggerIsBetter, noise } = comparison
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
  const filter = useTextFilter(
    rows,
    testOf,
    settings.test_filter,
    (text) => update({ test_filter: text }),
    { regex: settings.test_filter_regex },
  )
  const matching = filter.rows
  // The rows the table shows: those the filter keeps, without the noise when it is hidden.
  const hideNoise = useDeferredValue(settings.hide_noise)
  const shown = useMemo(
    () => (hideNoise ? matching.filter((row) => row.status !== 'noise') : matching),
    [matching, hideNoise],
  )
  const total = useMemo(
    () => (hideNoise ? rows.filter((row) => row.status !== 'noise').length : rows.length),
    [rows, hideNoise],
  )
  const counts = useMemo(() => summaryCounts(matching), [matching])

  // The table's columns, with the optional ones shown.
  const optional = settings.columns
  // The table follows the columns shown once it has had the time to render them, as for the noise.
  const deferredOptional = useDeferredValue(optional)
  const columns = useMemo(() => tableColumns(deferredOptional), [deferredOptional])

  // The table's rows, in the order they are sorted in, which a range selected with Shift follows.
  // A sort by a column that is not shown is the default one, and is dropped from the URL (CP7).
  // The same sort object from one render to the next, for the table not to render again.
  const usable = columns.some((entry) => entry.id === settings.sort.column)
  const { column, direction } = usable ? settings.sort : PARAMS.sort.default
  useEffect(() => {
    if (!usable) update({ sort: PARAMS.sort.default })
  }, [usable, update])
  const sort = useMemo(() => ({ column, direction }), [column, direction])
  const onSort = useCallback((next: TableSort) => update({ sort: next }), [update])
  const sorted = useMemo(() => sortComparison(shown, column, direction), [shown, column, direction])
  const sortedTests = useMemo(() => sorted.map(testOf), [sorted])

  // The hidden tests (CP2). Those the comparison no longer holds are forgotten once it is complete,
  // and neither the filter nor "Hide noise" changes them.
  const allTests = useMemo(() => tests?.map((entry) => entry.test), [tests])
  const { selected: hiddenTests, rows: hidden } = useRangeSelection(allTests, sortedTests, {
    inverted: true,
    initial: settings.hidden_test,
  })
  const compared = useMemo(
    () => sorted.filter((row) => !hiddenTests.has(row.test)),
    [sorted, hiddenTests],
  )
  const complete = tests !== undefined
  const geomean = useMemo(() => geomeanRow(compared, biggerIsBetter), [compared, biggerIsBetter])
  // The same, in no particular order, for the chart, which sorts them its own way: sorting the
  // table by another column leaves it as it is.
  const plotted = useMemo(
    () => shown.filter((row) => !hiddenTests.has(row.test)),
    [shown, hiddenTests],
  )
  // Whether to show the Profile column: whether any test of the comparison has a profile, whatever
  // the filter, "Hide noise" and the hidden tests, so that the columns stay as they change.
  const { links } = profiles
  const profiled = useMemo(
    () => allTests?.some((test) => links.has(test)) ?? false,
    [allTests, links],
  )
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

  // The tests Add to Regression makes indicators of: the compared ones with a value on side B.
  // In no particular order, as the chart's, so that sorting the table does not change them.
  const regressionTests = useMemo(
    () => (complete ? plotted.filter((row) => row.b !== null).map(testOf) : undefined),
    [complete, plotted],
  )
  const csv = useMemo(
    () => (compared.length === 0 ? null : () => comparisonCsv(columns, geomean, compared)),
    [columns, compared, geomean],
  )

  // The hidden tests, in the URL while there are few enough of them to share (CP7). A long list
  // from the URL stays there until the comparison is complete, which may leave few enough of them.
  const shared = hiddenTests.size <= HIDDEN_IN_URL
  const hiddenSorted = useMemo(
    () => (shared ? [...hiddenTests].sort(compareStrings) : NO_TESTS),
    [hiddenTests, shared],
  )
  useEffect(() => {
    if (shared || complete) update({ hidden_test: hiddenSorted })
  }, [hiddenSorted, shared, complete, update])

  // Whether the table still shows the noise as it was classified before the latest change.
  const reclassifying =
    comparison.classifying || hideNoise !== settings.hide_noise || deferredOptional !== optional

  // Swapping the sides, or changing what side A is, dismisses the shadow (CP8). Changing side A's
  // run aggregation does not: the shadow follows it.
  const swap = () => sides.swap(NO_SHADOW)
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
            filter={filter}
            label="Filter tests"
            placeholder="Filter tests..."
            regex={settings.test_filter_regex}
            onRegexChange={(regex) => update({ test_filter_regex: regex })}
          />
          <NoiseControls settings={settings} update={update} />
        </div>
        <AddToRegression
          suite={b.settings.suite}
          machine={b.settings.machine}
          commit={b.settings.commit}
          metric={metric?.name ?? ''}
          tests={regressionTests}
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
          <SummaryBar counts={counts} />
          <CompareTable
            rows={sorted}
            columns={columns}
            menu={<ColumnsMenu shown={optional} onChange={(keys) => update({ columns: keys })} />}
            tests={sortedTests}
            hidden={hidden}
            summary={
              filter.active
                ? `${compared.length} of ${shown.length} matching tests shown (${total} total)`
                : `${compared.length} of ${total} tests shown`
            }
            notInUrl={shared ? undefined : `The URL holds at most ${HIDDEN_IN_URL} hidden tests.`}
            geomean={geomean}
            csv={csv}
            busy={reclassifying}
            hovered={hovered}
            emphasis={emphasis}
            links={links}
            profiled={profiled}
            empty={
              rows.length === 0
                ? 'No test has a value for this metric.'
                : matching.length === 0
                  ? 'No tests match the filter.'
                  : 'Every matching test is classified as noise.'
            }
            sort={sort}
            onSort={onSort}
          />
        </>
      )}
    </section>
  )
}
