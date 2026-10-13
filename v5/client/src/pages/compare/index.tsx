import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import type { Schemas } from '../../api/client'
import { runRefKey, useRunSamples, type RunRef, type SampleState } from '../../api/runs'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { plural } from '../../format'
import { isNumeric, labelOf, type Metric } from '../../schema'
import { useDropUnusable, useUrlState, useVisitKey } from '../../url-state'
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
import { CompareTable } from './compare-table'
import { NoiseControls } from './noise-controls'
import { PARAMS, sideChanges } from './settings'
import { SidePanel } from './side-panel'
import { SummaryBar } from './summary-bar'
import { useSide, type Side } from './use-side'
import styles from './compare.module.css'

type Sample = Schemas['Sample']

const NO_ROWS: ComparisonRow[] = []
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
 * have all arrived.
 */
function useRunSamplesOf(
  side: Side,
  states: ReadonlyMap<string, SampleState>,
): Sample[][] | undefined {
  const { selected, runs } = side
  const { suite } = side.settings
  return useMemo(() => {
    if (selected === undefined || runs.data === undefined) return undefined
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
  const noise = useDeferredValue(useMemo(() => ({ pct, pval, floor }), [pct, pval, floor]))
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
  const hideNoise = settings.hide_noise
  const shown = useMemo(
    () => (hideNoise ? matching.filter((row) => row.status !== 'noise') : matching),
    [matching, hideNoise],
  )
  const total = useMemo(
    () => (hideNoise ? rows.filter((row) => row.status !== 'noise').length : rows.length),
    [rows, hideNoise],
  )
  const geomean = useMemo(() => geomeanRow(shown, biggerIsBetter), [shown, biggerIsBetter])
  const counts = useMemo(() => summaryCounts(matching), [matching])
  const onNoise = useCallback(
    (knob: NoiseKnob, value: number | null) => update({ [`noise_${knob}`]: value }),
    [update],
  )

  // The same objects from one render to the next, for the table not to render again.
  const { column, direction } = settings.sort
  const sort = useMemo(() => ({ column, direction }), [column, direction])
  const onSort = useCallback((next: TableSort) => update({ sort: next }), [update])

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
            noise={{ pct, pval, floor }}
            onNoise={onNoise}
            hideNoise={hideNoise}
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
          <SummaryBar counts={counts} />
          <CompareTable
            rows={shown}
            geomean={geomean}
            total={total}
            filtered={filter.active}
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
