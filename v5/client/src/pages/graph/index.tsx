import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { AGGREGATIONS, type Aggregation } from '../../aggregation'
import { useMachineNames } from '../../api/machines'
import { useScaffold } from '../../api/scaffold'
import { useSeries, type Batch } from '../../api/series'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { useTestNames } from '../../api/tests'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage } from '../../components/feedback'
import { useRangeSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { useTextFilter } from '../../components/use-text-filter'
import { traceColor } from '../../chart-colors'
import { compareStrings } from '../../format'
import { isNumeric, labelOf, type Metric } from '../../schema'
import {
  booleanParam,
  enumParam,
  stringParam,
  trimmedStringParam,
  useDropUnusable,
  useUrlState,
  type Param,
} from '../../url-state'
import { GraphChart } from './graph-chart'
import { MachineChips } from './machine-chips'
import { TestTable } from './test-table'
import styles from './graph.module.css'

/** At most how many tests can be selected at once (GR7). */
const SELECTION_LIMIT = { count: 100, why: 'At most 100 tests can be selected at once.' }

/** At most how many selected tests the URL holds (GR14). */
const TESTS_IN_URL = 10

/** A parameter repeated once per value, each value kept once, in the order first given. */
function uniqueListParam(): Param<string[]> {
  return { default: [], parse: (values) => [...new Set(values)], serialize: (value) => value }
}

const PARAMS = {
  suite: stringParam(),
  /** The machines, in the order of their chips. */
  machine: uniqueListParam(),
  metric: stringParam(),
  test_filter: trimmedStringParam(),
  test_filter_regex: booleanParam(false),
  test: uniqueListParam(),
  sample_agg: enumParam(AGGREGATIONS, 'median'),
  run_agg: enumParam(AGGREGATIONS, 'median'),
}

const AGGREGATION_OPTIONS = AGGREGATIONS.map((value) => ({ value, label: value }))

const NO_NAMES: string[] = []
const nameOf = (name: string) => name

/**
 * The Graph page (GR1-GR14), started afresh whenever the user navigates to it -- a link to another
 * graph while on this one, say -- so that its selection is the one the new URL names. Its own
 * changes to the URL replace the history entry (AR2 "State"), and leave it as it is.
 */
export default function Graph() {
  const location = useLocation()
  const navigation = useNavigationType()
  const [visit, setVisit] = useState(location.key)
  if (navigation !== 'REPLACE' && location.key !== visit) setVisit(location.key)
  return <GraphPage key={visit} />
}

function GraphPage() {
  const [settings, update] = useUrlState(PARAMS)
  const suites = useSuites()
  const schema = suites.data?.find((entry) => entry.name === settings.suite)
  // A suite that does not exist is dropped (AR2 "State"), and what was chosen in it with it.
  useDropUnusable(
    suites,
    (list) => settings.suite === '' || list.some((entry) => entry.name === settings.suite),
    () => update({ suite: '', machine: [], metric: '', test: [] }),
  )

  return (
    <section>
      <h1>Graph</h1>
      {suites.isError && (
        <ErrorMessage error={suites.error} onRetry={() => void suites.refetch()} />
      )}
      <Graphed
        suites={suites.data ?? []}
        schema={schema}
        settings={settings}
        update={update}
      />
    </section>
  )
}

type Settings = ReturnType<typeof useUrlState<typeof PARAMS>>[0]
type Update = ReturnType<typeof useUrlState<typeof PARAMS>>[1]

interface GraphedProps {
  suites: SuiteSchema[]
  /** The suite selected, once the suites are known to hold it. */
  schema: SuiteSchema | undefined
  settings: Settings
  update: Update
}

/** The page's controls, chart and test table, for the suite selected, if any (GR1). */
function Graphed({ suites, schema, settings, update }: GraphedProps) {
  const suite = schema?.name ?? ''
  const numeric = useMemo(() => schema?.metrics.filter(isNumeric) ?? [], [schema])

  const machineNames = useMachineNames(suite, schema !== undefined)
  const names = machineNames.data
  // The machines chosen that exist, once that is known: nothing is fetched for the others, which
  // are dropped (AR2 "State").
  const machines = useMemo(
    () => (names ? settings.machine.filter((name) => names.includes(name)) : NO_NAMES),
    [names, settings.machine],
  )
  useDropUnusable(
    machineNames,
    (list) => settings.machine.every((name) => list.includes(name)),
    () => update({ machine: machines }),
  )

  // The metric, once the suite is known to offer it: only a numeric one can be plotted (GR1).
  const metric = numeric.find((entry) => entry.name === settings.metric)
  const unusableMetric = schema !== undefined && settings.metric !== '' && metric === undefined
  useEffect(() => {
    if (unusableMetric) update({ metric: '' })
  }, [unusableMetric, update])

  const tests = useTestNames(suite, metric === undefined ? NO_NAMES : machines, metric?.name ?? '')
  const filter = useTextFilter(
    tests.names,
    nameOf,
    settings.test_filter,
    (text) => update({ test_filter: text }),
    { regex: settings.test_filter_regex },
  )
  // The tests that can be selected, once they are all known: those the filter keeps, of every
  // machine's tests for the metric. Until then -- while the suite, the machines or the metric are
  // being checked, or a machine's tests listed -- the selection stays as it is (GR1, GR14).
  const known = names !== undefined && metric !== undefined && tests.complete && !tests.error
  const selection = useRangeSelection(known ? filter.rows : undefined, filter.rows, {
    limit: SELECTION_LIMIT,
    initial: settings.test,
  })
  const { selected, rows } = selection

  // The selection, in the URL while it is short enough to share (GR14).
  const sorted = useMemo(() => [...selected].sort(compareStrings), [selected])
  const shared = sorted.length <= TESTS_IN_URL
  useEffect(() => {
    update({ test: shared ? sorted : [] })
  }, [sorted, shared, update])

  // The tests each machine's list holds, of the machines whose list is in, in the chips' order.
  const testsOf = useMemo(() => {
    const listed = machines.flatMap((name) => {
      const held = tests.byMachine.get(name)
      return held === undefined ? [] : [[name, held] as const]
    })
    return new Map(listed)
  }, [machines, tests.byMachine])
  const series = useSeries(suite, metric?.name ?? '', selected, testsOf)
  const scaffold = useScaffold(suite, machines)

  // Each test's colour, by its position among every test listed, filtered or not, so that a test
  // keeps its colour however the selection or the filter changes (GR1).
  const colors = useMemo(
    () => new Map(tests.names.map((name, i) => [name, traceColor(i)])),
    [tests.names],
  )
  const loading = useMemo(
    () => loadingTests(series.batches, testsOf, selected),
    [series.batches, testsOf, selected],
  )
  const listing = metric !== undefined && machines.length > 0 && !tests.complete

  // Nothing chosen in a suite applies to another (GR1). The selection is cleared at once, so that
  // writing it to the URL does not put back the tests of the suite left.
  const chooseSuite = (name: string) => {
    rows.replace([])
    update({ suite: name, machine: [], metric: '', test: [] })
  }

  const disabled = schema === undefined
  return (
    <>
      <ControlsPanel>
        <Select
          label="Suite"
          options={suites.map((entry) => ({ value: entry.name, label: entry.name }))}
          value={schema === undefined ? null : schema.name}
          placeholder="-- Select suite --"
          onChange={chooseSuite}
        />
        <MachineChips
          machines={settings.machine}
          names={names}
          pending={!disabled && machineNames.isPending}
          isDisabled={disabled}
          onChange={(chosen) => update({ machine: chosen })}
        />
        {schema !== undefined && numeric.length === 0 ? (
          <p className={styles.note}>This suite has no numeric metric.</p>
        ) : (
          <Select
            label="Metric"
            options={numeric.map((entry) => ({ value: entry.name, label: labelOf(entry) }))}
            value={metric?.name ?? null}
            placeholder="-- Select metric --"
            onChange={(name) => update({ metric: name })}
            isDisabled={disabled}
          />
        )}
        <Select<Aggregation>
          label="Sample aggregation"
          options={AGGREGATION_OPTIONS}
          value={settings.sample_agg}
          onChange={(value) => update({ sample_agg: value })}
          isDisabled={disabled}
        />
        <Select<Aggregation>
          label="Run aggregation"
          options={AGGREGATION_OPTIONS}
          value={settings.run_agg}
          onChange={(value) => update({ run_agg: value })}
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
      </ControlsPanel>
      {machineNames.isError && (
        <ErrorMessage
          context="The machines could not be listed"
          error={machineNames.error}
          onRetry={() => void machineNames.refetch()}
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
          context={`The commits of ${machine} could not be listed`}
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
      <GraphChart
        schema={schema}
        metric={metric}
        machines={machines}
        selected={sorted}
        colors={colors}
        scaffold={scaffold}
        series={series}
        sampleAgg={settings.sample_agg}
        runAgg={settings.run_agg}
        busy={listing || scaffold.pending || loading.size > 0}
        failed={tests.error !== null || scaffold.failures.length > 0 || series.error !== null}
      />
      {!shared && (
        <p className={styles.warning} role="status">
          More than {TESTS_IN_URL} tests are selected, so the selection is not part of the URL and
          cannot be shared with it.
        </p>
      )}
      <TestTable
        all={tests.names}
        shown={filter.rows}
        filtered={filter.active}
        selection={selection}
        colors={colors}
        loading={loading}
        listing={listing}
        empty={emptyTable(schema, machines, metric)}
      />
    </>
  )
}

/**
 * The selected tests whose data is still loading on some machine whose list holds them: those of a
 * batch with pages to come, and those no batch holds yet. A batch that failed is not loading.
 */
function loadingTests(
  batches: Batch[],
  testsOf: ReadonlyMap<string, ReadonlySet<string>>,
  selected: ReadonlySet<string>,
): ReadonlySet<string> {
  const loaded = new Set<string>()
  for (const batch of batches) {
    if (!batch.complete && batch.error === null) continue
    for (const test of batch.tests) loaded.add(`${batch.machine}\0${test}`)
  }
  const loading = new Set<string>()
  for (const [machine, held] of testsOf) {
    for (const test of selected) {
      if (held.has(test) && !loaded.has(`${machine}\0${test}`)) loading.add(test)
    }
  }
  return loading
}

/** What the test table says while it has no tests to list, and why. */
function emptyTable(
  schema: SuiteSchema | undefined,
  machines: readonly string[],
  metric: Metric | undefined,
): string {
  if (schema === undefined) return 'Select a suite first.'
  if (machines.length === 0) return 'Add a machine to list its tests.'
  if (metric === undefined) return 'Select a metric to list the tests that have it.'
  return 'No test has a value for this metric on the machines added.'
}
