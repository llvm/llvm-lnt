import { useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigationType } from 'react-router'
import { AGGREGATIONS, type Aggregation } from '../../aggregation'
import { useMachineNames } from '../../api/machines'
import { useScaffold } from '../../api/scaffold'
import { forgetGraphData, useSeries } from '../../api/series'
import { useSuites, type SuiteSchema } from '../../api/suites'
import { useTestNames } from '../../api/tests'
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
  // The suite, once the suites are known to hold it (see below for one that does not exist).
  const schema = suites.data?.find((entry) => entry.name === settings.suite)
  const suite = schema?.name ?? ''
  // What the page fetched in a suite is kept for as long as it shows it (GR8).
  const client = useQueryClient()
  useEffect(() => () => forgetGraphData(client, suite), [client, suite])

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

  const listedFor = metric === undefined ? NO_NAMES : machines
  const tests = useTestNames(suite, listedFor, metric?.name ?? '', { keep: true })
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

  // A suite that does not exist is dropped (AR2 "State"), and what was chosen in it with it.
  useDropUnusable(
    suites,
    (list) => settings.suite === '' || list.some((entry) => entry.name === settings.suite),
    () => {
      rows.replace([])
      update({ suite: '', machine: [], metric: '', test: [] })
    },
  )

  // The selection, in the URL while it is short enough to share (GR14). A long one from the URL
  // stays there until what it names is known, which may leave few enough of them to share.
  const sorted = useMemo(() => [...selected].sort(compareStrings), [selected])
  const shared = sorted.length <= TESTS_IN_URL
  useEffect(() => {
    if (shared || known) update({ test: shared ? sorted : [] })
  }, [sorted, shared, known, update])

  const series = useSeries(suite, metric?.name ?? '', selected, tests.byMachine)
  const scaffold = useScaffold(suite, machines)

  // Whether the suite or the machines the URL names are still being checked, which nothing the
  // page shows can be said to be empty or missing until.
  const checking =
    suites.isPending || (schema !== undefined && settings.machine.length > 0 && names === undefined)
  const listing =
    metric !== undefined && machines.length > 0 && !tests.complete && tests.error === null
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
        {/* What is plotted from: the suite, and its machines, whose chips stack below them. */}
        <div className={styles.sources}>
          <Select
            label="Suite"
            options={(suites.data ?? []).map(({ name }) => ({ value: name, label: name }))}
            value={schema === undefined ? null : schema.name}
            placeholder="-- Select suite --"
            onChange={chooseSuite}
          />
          <MachineChips
            // Once the machines are known, only those that exist, as the chart marks them.
            machines={names ? machines : settings.machine}
            names={names}
            pending={!disabled && machineNames.isPending}
            error={machineNames.error}
            isDisabled={disabled}
            onChange={(chosen) => update({ machine: chosen })}
          />
        </div>
        {/* How it is plotted. */}
        <div className={styles.settings}>
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
        </div>
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
        scaffold={scaffold}
        series={series}
        sampleAgg={settings.sample_agg}
        runAgg={settings.run_agg}
        settled={
          !checking && !listing && !scaffold.pending && series.loading.size === 0 && !failed
        }
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
        empty={emptyTable({ checking, schema, numeric, machines, metric })}
      />
    </section>
  )
}

interface Chosen {
  checking: boolean
  schema: SuiteSchema | undefined
  numeric: Metric[]
  machines: readonly string[]
  metric: Metric | undefined
}

/** What the test table says while it has no tests to list, and why. */
function emptyTable({ checking, schema, numeric, machines, metric }: Chosen): string {
  if (checking) return 'Loading...'
  if (schema === undefined) return 'Select a suite first.'
  if (numeric.length === 0) return 'This suite has no numeric metric to plot.'
  if (machines.length === 0) return 'Add a machine to list its tests.'
  if (metric === undefined) return 'Select a metric to list the tests that have it.'
  return 'No test has a value for this metric on the machines added.'
}
