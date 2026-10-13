import { Link } from 'react-router'
import type { Aggregation } from '../../aggregation'
import type { TraceState } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { ButtonLink } from '../../components/button-link'
import { DataTable, type Column } from '../../components/data-table'
import { formatTimestamp, plural, shortUuid } from '../../format'
import { commitPath, comparePath, machinePath, runPath } from '../../paths'
import { formatMetricValue, type Metric } from '../../schema'
import { ChartDialog, type Anchor } from './chart-dialog'
import type { Point, RunValue } from './points'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema
  metric: Metric
  machine: string
  test: string
  point: Point
  /** The display value of the point's commit. */
  display: string
  /** The point's runs, each with its value, in the order they were submitted. */
  runs: RunValue[]
  /** The point before it on its trace, if there is one. */
  previous: Point | null
  /** How far the trace's data is loaded. */
  state: TraceState
  sampleAgg: Aggregation
  runAgg: Aggregation
  /** Where the point is. */
  at: Anchor
  onClose(returnFocus?: boolean): void
}

/**
 * The details of a point clicked on the chart (GR11), in a dialog beside it: its machine, commit,
 * value, the runs the value combines, and a comparison with the point before it.
 */
export function PointDetails({
  schema,
  metric,
  machine,
  test,
  point,
  display,
  runs,
  previous,
  state,
  sampleAgg,
  runAgg,
  at,
  onClose,
}: Props) {
  const suite = schema.name

  // An aggregation in the comparison's URL, unless it is Compare's default.
  const unlessDefault = (how: Aggregation) => (how === 'median' ? undefined : how)
  const side = (commit: string) => ({ suite, machine, commit })
  let compare: string | null = null
  let why: string | undefined
  if (state === 'loading') why = "The test's data is still loading."
  else if (state === 'failed') why = "The test's data could not all be loaded."
  else if (previous === null) why = 'This is the first point of its trace.'
  else {
    compare = comparePath(
      side(previous.commit),
      side(point.commit),
      { metric: metric.name, sampleAgg: unlessDefault(sampleAgg), runAgg: unlessDefault(runAgg) },
    )
  }

  return (
    <ChartDialog
      label={`${test} on ${machine} at ${display}`}
      title={test}
      at={at}
      onClose={onClose}
    >
      <dl className={styles.detailsInfo}>
        <dt>Machine</dt>
        <dd>
          <Link to={machinePath(suite, machine)}>{machine}</Link>
        </dd>
        <dt>Commit</dt>
        <dd>
          <Link to={commitPath(suite, point.commit)}>{display}</Link>
        </dd>
        <dt>Value</dt>
        <dd>
          {formatMetricValue(point.value, metric)} ({plural(point.runs, 'run')})
        </dd>
      </dl>
      <div className={styles.detailsRuns}>
        <h3 className={styles.detailsHeading}>Runs</h3>
        <DataTable
          label="Runs"
          columns={runColumns(suite, metric)}
          rows={runs}
          rowKey={runKey}
          empty="No runs."
        />
      </div>
      <ButtonLink to={compare} title={why}>
        Compare with previous commit
      </ButtonLink>
    </ChartDialog>
  )
}

const runKey = (run: RunValue) => run.run

/** The columns of the table of a point's runs: when each was submitted, which, and its value. */
function runColumns(suite: string, metric: Metric): Column<RunValue>[] {
  return [
    {
      id: 'submitted',
      header: 'Submitted',
      cell: (run) => formatTimestamp(run.submitted),
      looks: ['nowrap'],
    },
    {
      id: 'run',
      header: 'Run',
      cell: (run) => <Link to={runPath(suite, run.run)}>{shortUuid(run.run)}</Link>,
      looks: ['mono', 'nowrap'],
    },
    {
      id: 'value',
      header: 'Value',
      cell: (run) => formatMetricValue(run.value, metric),
      looks: ['numeric', 'nowrap'],
    },
  ]
}
