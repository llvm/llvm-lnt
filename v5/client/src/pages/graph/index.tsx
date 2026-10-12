import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigationType } from 'react-router'
import { AGGREGATIONS, type Aggregation } from '../../aggregation'
import { useMachineNames } from '../../api/machines'
import { useScaffold } from '../../api/scaffold'
import { useSeries } from '../../api/series'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { useTestNames } from '../../api/tests'
import { traceColor } from '../../chart-colors'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage } from '../../components/feedback'
import { useRangeSelection } from '../../components/range-selection'
import { RegexFilter } from '../../components/regex-filter'
import { Select } from '../../components/select'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings } from '../../format'
import { isNumeric, labelOf, type Metric } from '../../schema'
import {
  booleanParam,
  enumParam,
  listParam,
  stringParam,
  trimmedStringParam,
  useDropUnusable,
  useUrlState,
} from '../../url-state'
import { GraphChart } from './graph-chart'
import { MachineChips } from './machine-chips'
import { TestTable } from './test-table'
import styles from './graph.module.css'

/** At most how many tests can be selected at once (GR7). */
const SELECTION_LIMIT = { count: 100, why: 'At most 100 tests can be selected at once.' }

/** At most how many selected tests the URL holds (GR14). */
const TESTS_IN_URL = 10

const PARAMS = {
  suite: stringParam(),
  /** The machines, in the order of their chips. */
  machine: listParam(),
  metric: stringParam(),
  test_filter: trimmedStringParam(),
  test_filter_regex: booleanParam(false),
  test: listParam(),
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
  // The suite, once the suites are known to hold it. One that does not exist is dropped (AR2
  // "State"), and what was chosen in it with it.
  const schema = suites.data?.find((entry) => entry.name === settings.suite)
  useDropUnusable(
    suites,
    (list) => settings.suite === '' || list.some((entry) => entry.name === settings.suite),
    () => update({ suite: '', machine: [], metric: '', test: [] }),
  )
  const suite = schema?.name ?? ''

  // The machines chosen that exist, once that is known: nothing is fetched for the others, which
  // are dropped.
  const machineNames = useMachineNames(suite, schema !== undefined)
  const names = machineNames.data
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
  const numeric = useMemo(() => schema?.metrics.filter(isNumeric) ?? [], [schema])
  const metric = numeric.find((entry) => entry.name === settings.metric)
  useDropUnusable(
    suites,
    () => schema === undefined || settings.metric === '' || metric !== undefined,
    () => update({ metric: '' }),
  )

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

  const series = useSeries(suite, metric?.name ?? '', selected, tests.byMachine)
  const scaffold = useScaffold(suite, machines)

  // Each test's colour, by its position among every test listed, filtered or not, so that a test
  // keeps its colour however the selection or the filter changes (GR1).
  const colors = useMemo(
    () => new Map(tests.names.map((name, i) => [name, traceColor(i)])),
    [tests.names],
  )
  const listing = metric !== undefined && machines.length > 0 && !tests.complete
  const failed = tests.error !== null || scaffold.failures.length > 0 || series.error !== null

  // Nothing chosen in a suite applies to another (GR1). The selection is cleared at once, so that
  // writing it to the URL does not put back the tests of the suite left.
  const chooseSuite = (name: string) => {
    rows.replace([])
    update({ suite: name, machine: [], metric: '', test: [] })
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
        <Select
          label="Suite"
          options={(suites.data ?? []).map(({ name }) => ({ value: name, label: name }))}
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
        settled={!listing && !scaffold.pending && series.loading.size === 0 && !failed}
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
        loading={series.loading}
        listing={listing}
        empty={emptyTable(schema, machines, metric)}
      />
    </section>
  )
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
