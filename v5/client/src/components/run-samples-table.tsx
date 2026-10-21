import { useMemo } from 'react'
import { formatTimestamp } from '../format'
import { runPath } from '../paths'
import { formatMetricValue, type Metric } from '../schema'
import dialog from './chart-dialog.module.css'
import { DataTable, type Column } from './data-table'
import { UuidLink } from './uuid-link'

/** One run's samples of a test, for a metric. */
export interface RunSamples {
  /** The run's UUID. */
  run: string
  /** When the run was measured. */
  measured: string
  samples: number[]
}

interface Props {
  /** The table's accessible name. */
  label: string
  /** The runs' suite. */
  suite: string
  metric: Metric
  /** The runs, in the order they were measured, each with its samples, ascending. */
  runs: RunSamples[]
}

/**
 * Runs and their samples, in a chart's dialog (GR11, CP3): each run's measurement time, its
 * shortened UUID linking to its Run Detail page, and its samples on one line, in a list that
 * scrolls when it is long or wide.
 */
export function RunSamplesTable({ label, suite, metric, runs }: Props) {
  const columns = useMemo(() => runColumns(suite, metric), [suite, metric])
  return (
    <div className={dialog.list}>
      <DataTable
        label={label}
        columns={columns}
        rows={runs}
        rowKey={runKey}
        empty="No runs."
      />
    </div>
  )
}

const runKey = (run: RunSamples) => run.run

/** The columns of the table: when each run was measured, which run it is, and its samples. */
function runColumns(suite: string, metric: Metric): Column<RunSamples>[] {
  return [
    {
      id: 'measured',
      header: 'Measured',
      cell: (run) => formatTimestamp(run.measured),
      looks: ['nowrap'],
    },
    {
      id: 'run',
      header: 'Run',
      cell: (run) => <UuidLink uuid={run.run} to={runPath(suite, run.run)} />,
    },
    {
      id: 'samples',
      header: 'Samples',
      cell: (run) => run.samples.map((value) => formatMetricValue(value, metric)).join(' · '),
      looks: ['numeric', 'nowrap'],
    },
  ]
}
