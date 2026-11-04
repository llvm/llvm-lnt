import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  AGGREGATION_OPTIONS,
  AGGREGATIONS,
  DEFAULT_AGGREGATION,
  type Aggregation,
} from '../../aggregation'
import { hasMachine, useMachineLabels, useMachineList } from '../../api/machines'
import { useMarkedRegressions } from '../../api/regressions'
import { useScaffold } from '../../api/scaffold'
import { forgetGraphData, useSeries } from '../../api/series'
import {
  findSuite,
  NO_SUITE,
  fullName,
  suiteOfFullName,
  suiteRef,
  useSuites,
  type Suite,
  type SuiteRef,
} from '../../api/suites'
import { useTestNames } from '../../api/tests'
import { ChipList } from '../../components/chip-list'
import { storeCommitLookup, suggestionOf } from '../../components/commit-lookup'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage } from '../../components/feedback'
import { useRangeSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings } from '../../format'
import { suiteOption } from '../../labels'
import { ACTIVE_STATES, REGRESSION_STATES, type RegressionState } from '../../regression-states'
import { displayValueOf, isNumeric, type Metric } from '../../schema'
import {
  booleanParam,
  enumParam,
  listParam,
  stringParam,
  type Param,
  trimmedStringParam,
  useDropUnusable,
  useUrlState,
  useVisitKey,
} from '../../url-state'
import { ValueStore } from '../../value-store'
import { BaselinePanel } from './baseline-panel'
import {
  baselineParam,
  type Baseline,
  forgetBaselines,
  formatBaseline,
  useBaselines,
  useParsedBaselines,
} from './baselines'
import { GraphChart } from './graph-chart'
import { MachineChips } from './machine-chips'
import { MetricChips } from './metric-chips'
import { TestTable } from './test-table'
import styles from './graph.module.css'

/** At most how many tests can be selected at once (GR7). */
const SELECTION_LIMIT = { count: 100, why: 'At most 100 tests can be selected at once.' }

/** At most how many selected tests the URL holds (GR14). */
const TESTS_IN_URL = 10

/** At most how many commits can be highlighted at once (GR16). */
const HIGHLIGHT_LIMIT = { count: 10, why: 'At most 10 commits can be highlighted at once.' }

/** The highlighted commits (GR16): each once, and only the first 10 of a URL naming more. */
function highlightParam(): Param<string[]> {
  const list = listParam()
  return { ...list, parse: (values) => list.parse(values)?.slice(0, HIGHLIGHT_LIMIT.count) }
}

/** Which regressions are marked on the chart (GR15). */
const ANNOTATIONS = [
  { value: 'off', label: 'Off' },
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
] as const

type Annotations = (typeof ANNOTATIONS)[number]['value']

/** The states of the regressions each mode marks (GR15): those still worked on, or every one. */
const MARKED: Record<Exclude<Annotations, 'off'>, readonly RegressionState[]> = {
  active: ACTIVE_STATES,
  all: REGRESSION_STATES,
}

const PARAMS = {
  // The suite, by its project's name and its own (AR22), which go together.
  project: stringParam(),
  suite: stringParam(),
  /** The machines, in the order of their chips. */
  machine: listParam(),
  /** The metrics, in the order of their chips, which is that of the chart's panels. */
  metric: listParam(),
  test_filter: trimmedStringParam(),
  test_filter_regex: booleanParam(false),
  test: listParam(),
  sample_agg: enumParam(AGGREGATIONS, DEFAULT_AGGREGATION),
  run_agg: enumParam(AGGREGATIONS, DEFAULT_AGGREGATION),
  regressions: enumParam(ANNOTATIONS.map((option) => option.value), 'off'),
  baseline: baselineParam(),
  highlight: highlightParam(),
}

/** What a suite change clears, since it does not apply to another suite (GR1). */
const IN_SUITE = {
  machine: [] as string[],
  metric: [] as string[],
  test: [] as string[],
  highlight: [] as string[],
}

const NO_NAMES: string[] = []
const NO_METRICS: Metric[] = []
const NO_SUITES: Suite[] = []
const nameOf = (name: string) => name

/**
 * The Graph page (GR1-GR16), started afresh whenever the user navigates to it -- a link to another
 * graph while on this one, say -- so that its selection is the one the new URL names.
 */
export default function Graph() {
  return <GraphPage key={useVisitKey()} />
}

function GraphPage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  // The suite, once the suites are known to hold it (see below for one that does not exist).
  const named = suiteRef(settings.project, settings.suite)
  const schema = findSuite(suites.data, named)
  const suite = schema ? named : NO_SUITE
  // What the page fetched in a suite is kept for as long as it shows it (GR8).
  const client = useQueryClient()
  useEffect(() => () => forgetGraphData(client, suite), [client, suite])
  useEffect(() => () => forgetBaselines(client), [client])
  // The test hovered in the table, and the one hovered on the chart (GR7).
  const [emphasis] = useState(() => new ValueStore<string | null>(null))
  const [hovered] = useState(() => new ValueStore<string | null>(null))

  // The machines chosen that exist, once that is known: nothing is fetched for the others, which
  // are dropped.
  const machineList = useMachineList(suite, schema !== undefined)
  const listed = machineList.data
  const labelOfMachine = useMachineLabels(suite, schema !== undefined)
  const machines = useMemo(
    () =>
      listed ? settings.machine.filter((name) => hasMachine(listed, name)) : NO_NAMES,
    [listed, settings.machine],
  )
  useDropUnusable(
    machineList,
    (list) => settings.machine.every((name) => hasMachine(list, name)),
    () => update({ machine: machines }),
  )

  // The metrics chosen that the suite is known to offer: only a numeric one can be plotted (GR1).
  const numeric = useMemo(() => schema?.metrics.filter(isNumeric) ?? NO_METRICS, [schema])
  const metrics = useMemo(
    () =>
      settings.metric.flatMap((name) => numeric.find((entry) => entry.name === name) ?? []),
    [numeric, settings.metric],
  )
  const metricNames = useMemo(() => metrics.map((metric) => metric.name), [metrics])
  useDropUnusable(
    suites,
    () => schema === undefined || metrics.length === settings.metric.length,
    () => update({ metric: metricNames }),
  )

  const tests = useTestNames(suite, machines, metricNames, { keep: true })
  const filter = useTextFilter(
    tests.names,
    nameOf,
    settings.test_filter,
    (text) => update({ test_filter: text }),
    { regex: settings.test_filter_regex },
  )
  // The tests that can be selected, once they are all known: every machine's tests for every
  // metric, whatever the filter, which only narrows the table. Until then -- while the suite, the
  // machines or the metrics are being checked, or a machine's tests listed -- the selection stays
  // as it is (GR1, GR14). So does it while no metric is chosen, so that a metric can be replaced by
  // another without losing it (GR1).
  const known =
    listed !== undefined && metrics.length > 0 && tests.complete && tests.error === null
  const selection = useRangeSelection(known ? tests.names : undefined, filter.rows, {
    limit: SELECTION_LIMIT,
    initial: settings.test,
  })
  const { selected, rows } = selection

  // A suite that does not exist is dropped (AR2 "State"), and what was chosen in it with it.
  useDropUnusable(
    suites,
    (list) => named === NO_SUITE || findSuite(list, named) !== undefined,
    () => {
      rows.replace([])
      update({ project: '', suite: '', ...IN_SUITE })
    },
  )

  // The selection, in the URL while it is short enough to share (GR14). A long one from the URL
  // stays there until what it names is known, which may leave few enough of them to share.
  const sorted = useMemo(() => [...selected].sort(compareStrings), [selected])
  const shared = sorted.length <= TESTS_IN_URL
  useEffect(() => {
    if (shared || known) update({ test: shared ? sorted : [] })
  }, [sorted, shared, known, update])

  const series = useSeries(suite, metricNames, selected, tests.byMetric)
  const scaffold = useScaffold(suite, machines)

  // The baselines (GR9), those of the URL that are unusable dropped (AR2 "State").
  const baselines = useBaselines(
    useParsedBaselines(settings.baseline),
    suites.data,
    metrics,
    selected,
  )
  const { states } = baselines
  useEffect(() => {
    const unusable = states.filter((state) => state.unusable)
    const dropped = new Set(unusable.map((state) => formatBaseline(state.baseline)))
    if (dropped.size > 0) update({ baseline: settings.baseline.filter((v) => !dropped.has(v)) })
  }, [states, settings.baseline, update])

  const addBaseline = (baseline: Baseline) => {
    const value = formatBaseline(baseline)
    if (!settings.baseline.includes(value)) update({ baseline: [...settings.baseline, value] })
  }
  const removeBaseline = (value: string) =>
    update({ baseline: settings.baseline.filter((entry) => entry !== value) })

  // The regressions marked (GR15): those of the selected tests that some list holds, since the
  // API refuses a test that does not exist (E8).
  const marked = useMemo(() => {
    const held = new Set(tests.names)
    return sorted.filter((test) => held.has(test))
  }, [sorted, tests.names])
  const mode = settings.regressions
  const regressions = useMarkedRegressions(
    suite,
    {
      machines,
      tests: marked,
      metrics: metricNames,
      states: mode === 'off' ? [] : MARKED[mode],
    },
    mode !== 'off' && machines.length > 0 && marked.length > 0,
  )

  // Whether the suite or the machines the URL names are still being checked, which nothing the
  // page shows can be said to be empty or missing until.
  const checking =
    suites.isPending ||
    (schema !== undefined && settings.machine.length > 0 && listed === undefined)
  const listing = !tests.complete && tests.error === null
  // The measurements' loading and failures are each metric's (see GraphChart).
  const failed = tests.error !== null || scaffold.failures.length > 0

  // Nothing chosen in a suite applies to another (GR1). The selection is cleared at once, so that
  // writing it to the URL does not put back the tests of the suite left.

  const chooseSuite = (picked: SuiteRef) => {
    rows.replace([])
    update({ project: picked.project, suite: picked.suite, ...IN_SUITE })
  }

  // The highlighted commits (GR16), each shown by its display value once on the x-axis, which
  // gives it.
  const { highlight } = settings
  const onAxis = useMemo(
    () => new Map(scaffold.commits.map((commit) => [commit.value, commit])),
    [scaffold.commits],
  )
  const drawnHighlights = useMemo(
    () => highlight.filter((value) => onAxis.has(value)),
    [highlight, onAxis],
  )
  const shownHighlight = (value: string) =>
    schema === undefined ? value : displayValueOf(value, onAxis, schema)
  const highlightChips =
    schema === undefined
      ? []
      : highlight.map((value) => ({ key: value, text: `Highlighted: ${shownHighlight(value)}` }))
  const toggleHighlight = (commit: string) =>
    update({
      highlight: highlight.includes(commit)
        ? highlight.filter((value) => value !== commit)
        : [...highlight, commit],
    })
  // What takes the focus once the last highlight is removed: the control before them.
  const addBaselineButton = useRef<HTMLButtonElement>(null)

  // A point's commit of its machine, as a baseline (GR9, GR11).
  const baselineAt = (machine: string, commit: string) =>
    formatBaseline({ suite, machine, commit })
  const isBaseline = (machine: string, commit: string) =>
    settings.baseline.includes(baselineAt(machine, commit))
  const toggleBaseline = (machine: string, commit: string) => {
    const value = baselineAt(machine, commit)
    if (settings.baseline.includes(value)) return removeBaseline(value)
    // Its point shows that the machine has runs at the commit, which is not looked up (AR15). The
    // point is on the x-axis, which holds the commit, and has details only while a suite is chosen.
    storeCommitLookup(client, suite, { machine }, suggestionOf(onAxis.get(commit)!, schema!))
    update({ baseline: [...settings.baseline, value] })
  }

  const disabled = schema === undefined
  return (
    <section>
      <h1>Graph</h1>
      {suites.isError && (
        <ErrorMessage
          context="The test suites could not be listed"
          error={suites.error}
          onRetry={() => void suites.refetch()}
        />
      )}
      <ControlsPanel>
        {/* What is plotted from: the suite, and its machines, whose chips stack below them. */}
        <div className={styles.sources}>
          <Select
            label="Suite"
            options={(suites.data ?? []).map(suiteOption)}
            value={schema === undefined ? null : fullName(suite)}
            placeholder="-- Select suite --"
            onChange={(key) => chooseSuite(suiteOfFullName(key))}
          />
          <MachineChips
            // Once the machines are known, only those that exist, as the chart marks them.
            machines={listed ? machines : settings.machine}
            all={listed}
            labelOfMachine={labelOfMachine}
            pending={!disabled && machineList.isPending}
            error={machineList.error}
            isDisabled={disabled}
            onChange={(chosen) => update({ machine: chosen })}
          />
          {schema !== undefined && numeric.length === 0 ? (
            <p className={styles.note}>This suite has no numeric metric.</p>
          ) : (
            <MetricChips
              metrics={metrics}
              all={numeric}
              isDisabled={disabled}
              onChange={(chosen) => update({ metric: chosen })}
            />
          )}
        </div>
        {/* How it is plotted. */}
        <div className={styles.settings}>
          <Select<Aggregation>
            label="Run aggregation"
            options={AGGREGATION_OPTIONS}
            value={settings.run_agg}
            onChange={(value) => update({ run_agg: value })}
            isDisabled={disabled}
          />
          <Select<Aggregation>
            label="Sample aggregation"
            options={AGGREGATION_OPTIONS}
            value={settings.sample_agg}
            onChange={(value) => update({ sample_agg: value })}
            isDisabled={disabled}
          />
          <RegexFilter
            filter={filter}
            label="Filter tests"
            placeholder="Filter tests..."
            regex={settings.test_filter_regex}
            onRegexChange={(regex) => update({ test_filter_regex: regex })}
            isDisabled={disabled}
          />
          <Select<Annotations>
            label="Regressions"
            options={ANNOTATIONS}
            value={mode}
            onChange={(value) => update({ regressions: value })}
            isDisabled={disabled}
          />
        </div>
        {/* What is drawn on the chart besides the data. */}
        <div className={styles.overlays}>
          <BaselinePanel
            suites={suites.data ?? NO_SUITES}
            baselines={baselines.states}
            onAdd={addBaseline}
            onRemove={removeBaseline}
            isDisabled={disabled}
            toggle={addBaselineButton}
          />
          <div className={styles.highlights}>
            <ChipList
              label="Highlighted commits"
              chips={highlightChips}
              removeLabel={(chip) => `Remove the highlight of ${shownHighlight(chip.key)}`}
              onRemove={toggleHighlight}
              focusWhenEmpty={() => addBaselineButton.current}
            />
          </div>
        </div>
      </ControlsPanel>
      {machineList.isError && (
        <ErrorMessage
          context="The machines could not be listed"
          error={machineList.error}
          onRetry={() => void machineList.refetch()}
        />
      )}
      {tests.error !== null && (
        <ErrorMessage
          context="The tests could not be listed"
          error={tests.error}
          onRetry={tests.retry}
        />
      )}
      {scaffold.failures.map(({ machine, error, retry }) => (
        <ErrorMessage
          key={machine}
          context={`The commits of ${labelOfMachine(machine)} could not be listed`}
          error={error}
          onRetry={retry}
        />
      ))}
      {series.error !== null && (
        <ErrorMessage
          context="The data of some tests could not be loaded"
          error={series.error}
          onRetry={series.retry}
        />
      )}
      {baselines.error !== null && (
        <ErrorMessage
          context="A baseline could not be loaded"
          error={baselines.error}
          onRetry={baselines.retry}
        />
      )}
      {regressions.error !== null && (
        <ErrorMessage
          context="The regressions could not be loaded"
          error={regressions.error}
          onRetry={regressions.retry}
        />
      )}
      <GraphChart
        schema={schema}
        metrics={metrics}
        machines={machines}
        labelOfMachine={labelOfMachine}
        selected={sorted}
        scaffold={scaffold}
        series={series}
        sampleAgg={settings.sample_agg}
        runAgg={settings.run_agg}
        settled={!checking && !listing && !scaffold.pending && !failed}
        baselines={baselines.states}
        regressions={regressions.regressions}
        highlights={drawnHighlights}
        highlightsFull={highlight.length < HIGHLIGHT_LIMIT.count ? undefined : HIGHLIGHT_LIMIT.why}
        onHighlight={toggleHighlight}
        isBaseline={isBaseline}
        onBaseline={toggleBaseline}
        emphasis={emphasis}
        hovered={hovered}
        closeOn={[
          sorted,
          machines.join('\0'),
          metricNames.join('\0'),
          settings.sample_agg,
          settings.run_agg,
          mode,
        ]}
      />
      <TestTable
        all={tests.names}
        shown={filter.rows}
        filtered={filter.active}
        selection={selection}
        loading={series.loading}
        // Why the URL does not reflect the selection, when it does not (GR14).
        notInUrl={
          shared ? undefined : `The URL reflects a selection of at most ${TESTS_IN_URL} tests.`
        }
        listing={listing}
        empty={emptyTable({ checking, schema, numeric, machines, metrics })}
        emphasis={emphasis}
        hovered={hovered}
      />
    </section>
  )
}

interface Chosen {
  checking: boolean
  schema: Suite | undefined
  numeric: readonly Metric[]
  machines: readonly string[]
  metrics: readonly Metric[]
}

/** What the test table says while it has no tests to list, and why. */
function emptyTable({ checking, schema, numeric, machines, metrics }: Chosen): string {
  if (checking) return 'Loading...'
  if (schema === undefined) return 'Select a suite first.'
  if (numeric.length === 0) return 'This suite has no numeric metric to plot.'
  if (machines.length === 0) return 'Add a machine to list its tests.'
  if (metrics.length === 0) return 'Add a metric to list the tests that have it.'
  if (metrics.length === 1) return 'No test has a value for this metric on the machines added.'
  return 'No test has a value for these metrics on the machines added.'
}
