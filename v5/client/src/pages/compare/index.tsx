import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import type { Schemas } from '../../api/client'
import { runRefKey, useRunSamples, type RunRef, type SampleState } from '../../api/runs'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useRangeSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings, plural } from '../../format'
import { isNumeric, labelOf, type Metric } from '../../schema'
import { useDropUnusable, useUrlState, useVisitKey } from '../../url-state'
import { ValueStore } from '../../value-store'
import {
  compareRows,
  geomeanRow,
  joinSides,
  sideSamples,
  sideValues,
  summaryCounts,
  type ComparisonRow,
  type NoiseKnob,
} from './comparison'
import { comparisonCsv, sortComparison, tableColumns, type OptionalKey } from './columns'
import { ColumnsMenu } from './columns-menu'
import { CompareChart } from './compare-chart'
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import { HIDDEN_IN_URL, PARAMS, sideChanges, type Settings } from './settings'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useSide, type Side } from './use-side'
import styles from './compare.module.css'

type Sample = Schemas['Sample']

const NO_ROWS: ComparisonRow[] = []
const NO_TESTS: string[] = []

/** The URL parameter of each noise knob (CP7). */
const NOISE_PARAMS = {
  pct: 'noise_pct',
  pval: 'noise_pval',
  floor: 'noise_floor',
} as const satisfies Record<NoiseKnob, keyof Settings>
const testOf = (row: ComparisonRow) => row.test

/**
 * The metrics the page offers (CP1): those of the one suite selected, or, with two, those both
 * declare alike, numeric, with the same `bigger_is_better` and `unit`. Labelled as the first
 * suite labels them.
 */
function offeredMetrics(a: SuiteSchema | undefined, b: SuiteSchema | undefined): Metric[] {
  const [first, second] = a === undefined ? [b, undefined] : [a, b]
  return (first?.metrics ?? []).filter(
    (entry) =>
      isNumeric(entry) &&
      (second === undefined ||
        second.metrics.some(
          (other) =>
            other.name === entry.name &&
            isNumeric(other) &&
            other.bigger_is_better === entry.bigger_is_better &&
            other.unit === entry.unit,
        )),
  )
}

/**
 * The Compare page (CP1-CP7), started afresh whenever the user navigates to it -- a link to another
 * comparison while on this one, say -- so that it shows what the new URL names.
 */
export default function Compare() {
  return <ComparePage key={useVisitKey()} />
}

/** The runs `side` has selected, by `runRefKey`, in the order they were submitted. */
function chosenRuns(side: Side): string[] {
  const { selected, runs, settings } = side
  if (selected === undefined || runs.data === undefined) return []
  return runs.data
    .filter((run) => selected.has(run.uuid))
    .map((run) => runRefKey({ suite: settings.suite, uuid: run.uuid }))
}

/**
 * The samples of each of the runs `side` has selected, in the order they were submitted, once they
 * have all arrived. With no run selected, there is nothing to compare, rather than nothing compared.
 */
function useRunSamplesOf(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
): Sample[][] | undefined {
  const { selected, runs } = side
  const { suite } = side.settings
  return useMemo(() => {
    if (selected === undefined || selected.size === 0 || runs.data === undefined) return undefined
    const samples = runs.data
      .filter((run) => selected.has(run.uuid))
      .map((run) => states.get(runRefKey({ suite, uuid: run.uuid }))?.samples)
    return samples.every((entry) => entry !== undefined) ? samples : undefined
  }, [selected, runs.data, suite, states])
}

/**
 * `array`, or the one it was before if that holds the same elements, so that what is computed from
 * it is not computed again: a side's runs' samples, when only the other side's change.
 */
function useSameElements<T>(array: readonly T[] | undefined): readonly T[] | undefined {
  const [kept, setKept] = useState(array)
  const same =
    kept === array ||
    (kept !== undefined &&
      array !== undefined &&
      kept.length === array.length &&
      kept.every((item, i) => item === array[i]))
  if (!same) setKept(array)
  return same ? kept : array
}

/**
 * The side's samples for each test, once its selected runs' samples have arrived and `metric` is
 * known, and its value of each.
 */
function useSideComparison(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
  metric: string | undefined,
  sampleAgg: Aggregation,
) {
  const runSamples = useSameElements(useRunSamplesOf(side, states))
  const { runAgg } = side.settings
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

/** The runs of `first` and `second`, each once. */
function uniqueRuns(first: RunRef[], second: RunRef[]): RunRef[] {
  const unique = new Map([...first, ...second].map((ref) => [runRefKey(ref), ref]))
  return [...unique.values()]
}

function ComparePage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  // Which side each of these two holds. Swapping the sides swaps them, so that each side keeps
  // what it holds in memory, such as its runs selected, rather than reading it from the URL again,
  // which cannot say that none is.
  const [swapped, setSwapped] = useState(false)
  // The test whose row is hovered in the table, and the one whose bar is hovered on the chart (CP5).
  const [emphasis] = useState(() => new ValueStore<string | null>(null))
  const [hovered] = useState(() => new ValueStore<string | null>(null))
  const first = useSide(swapped ? 'b' : 'a', settings, update, suites)
  const second = useSide(swapped ? 'a' : 'b', settings, update, suites)
  const [a, b] = swapped ? [second, first] : [first, second]

  // The metric, once the suites are known to offer it (CP1).
  const offered = useMemo(() => offeredMetrics(a.schema, b.schema), [a.schema, b.schema])
  const metric = offered.find((entry) => entry.name === settings.metric)
  useDropUnusable(
    suites,
    () => settings.metric === '' || metric !== undefined,
    () => update({ metric: '' }),
  )

  // The samples of both sides' runs, asked for together, each run once.
  const refs = useMemo(() => uniqueRuns(first.refs, second.refs), [first.refs, second.refs])
  const wanted = useMemo(
    () => new Set([...first.wanted, ...second.wanted]),
    [first.wanted, second.wanted],
  )
  const states = useRunSamples(refs, wanted)

  // The comparison, each step computed again only when what it depends on changes.
  const { sample_agg: sampleAgg } = settings
  const sideA = useSideComparison(a, states, metric?.name, sampleAgg)
  const sideB = useSideComparison(b, states, metric?.name, sampleAgg)
  const { samples: samplesA, values: valuesA } = sideA
  const { samples: samplesB, values: valuesB } = sideB
  const tests = useMemo(
    () => (samplesA && samplesB ? joinSides(samplesA, samplesB) : undefined),
    [samplesA, samplesB],
  )
  const biggerIsBetter = metric?.bigger_is_better ?? false
  // The noise settings applied, which follow those set once the page has had the time to classify
  // every test again, so that a change to a knob never holds up the page while thousands of rows
  // are classified and rendered.
  const { noise_pct: pct, noise_pval: pval, noise_floor: floor } = settings
  const noiseSet = useMemo(() => ({ pct, pval, floor }), [pct, pval, floor])
  const noise = useDeferredValue(noiseSet)
  const rows = useMemo(
    () =>
      tests && valuesA && valuesB
        ? compareRows(tests, valuesA, valuesB, { biggerIsBetter, noise })
        : NO_ROWS,
    [tests, valuesA, valuesB, biggerIsBetter, noise],
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

  // The table's columns, with the optional ones shown, the same for as long as those are: the
  // URL's list is a new array whenever any setting changes.
  const shownKeys = settings.columns.join(',')
  const optional = useMemo(
    () => (shownKeys === '' ? [] : (shownKeys.split(',') as OptionalKey[])),
    [shownKeys],
  )
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
  const geomean = useMemo(() => geomeanRow(compared, biggerIsBetter), [compared, biggerIsBetter])
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
  const complete = tests !== undefined
  useEffect(() => {
    if (shared || complete) update({ hidden_test: hiddenSorted })
  }, [hiddenSorted, shared, complete, update])

  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [NOISE_PARAMS[knob]]: value }),
    [update],
  )
  // Whether the table still shows the noise as it was classified before the latest change.
  const reclassifying =
    noise !== noiseSet || hideNoise !== settings.hide_noise || deferredOptional !== optional

  const swap = () => {
    update({ ...sideChanges('a', b.settings), ...sideChanges('b', a.settings) })
    setSwapped(!swapped)
  }

  // How far the selected runs' samples are loaded, each run once, even when both sides select it.
  const chosen = [...new Set([...chosenRuns(a), ...chosenRuns(b)])].map((key) => states.get(key))
  const loaded = chosen.filter((state) => state?.samples !== undefined).length
  const failed = chosen.filter((state): state is SampleState => state?.error != null)
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
        <SidePanel side={a} title="Side A (Baseline)" suites={suites.data ?? []} />
        <button
          type="button"
          className={styles.swap}
          aria-label="Swap sides"
          title="Swap sides"
          onClick={swap}
        >
          ⇄
        </button>
        <SidePanel side={b} title="Side B (New)" suites={suites.data ?? []} />
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
            value={sampleAgg}
            onChange={(value) => update({ sample_agg: value })}
          />
          <RegexFilter
            filter={filter}
            label="Filter tests"
            placeholder="Filter tests..."
            regex={settings.test_filter_regex}
            onRegexChange={(regex) => update({ test_filter_regex: regex })}
          />
          <NoiseControls
            noise={noiseSet}
            onNoise={onNoise}
            hideNoise={settings.hide_noise}
            onHideNoise={(hide) => update({ hide_noise: hide })}
          />
        </div>
      </ControlsPanel>
      {failed.length > 0 && (
        <ErrorMessage
          context={`The samples of ${runCount(failed.length)} could not be loaded`}
          error={failed[0].error}
          onRetry={() => failed.forEach((state) => state.retry())}
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
        <Loading label={`Loading samples: ${loaded} of ${chosen.length} runs...`} />
      ) : (
        <>
          <CompareChart
            rows={compared}
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

/** `a run`, or `3 runs`. */
function runCount(count: number): string {
  return count === 1 ? 'a run' : plural(count, 'run')
}

/** What the comparison still needs before it can be computed, if anything (CP6 "Empty states"). */
function missingInput(a: Side, b: Side, offered: number, chosen: boolean): string | null {
  for (const side of [a, b]) {
    const letter = side.id.toUpperCase()
    const { machine, commit } = side.settings
    if (side.schema === undefined) return `Select a suite for side ${letter}.`
    if (machine === '') return `Select a machine for side ${letter}.`
    if (commit === '') return `Select a commit for side ${letter}.`
    if (side.selected?.size === 0) return `Select a run for side ${letter}.`
  }
  if (offered === 0) return 'The two suites have no metric that can be compared.'
  if (!chosen) return 'Select a metric.'
  return null
}
