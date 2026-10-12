import { useMemo } from 'react'
import type { Data } from 'plotly.js'
import type { Aggregation } from '../../aggregation'
import type { Scaffold } from '../../api/scaffold'
import type { Series } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { Chart } from '../../components/chart'
import { commitDisplayValue, labelOf, type Metric } from '../../schema'
import { graphLayout, plotlyTraces, type Trace } from './chart'
import { pointsOf } from './points'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema | undefined
  metric: Metric | undefined
  /** The machines plotted, in the order of their chips. */
  machines: readonly string[]
  /** The tests selected, in order. */
  selected: readonly string[]
  colors: ReadonlyMap<string, string>
  scaffold: Scaffold
  series: Series
  sampleAgg: Aggregation
  runAgg: Aggregation
  /** Whether something the chart draws is still loading. */
  busy: boolean
  /** Whether something the chart draws could not be loaded. */
  failed: boolean
}

/**
 * The chart of the Graph page (GR1): a trace per selected test and machine, on the commits of the
 * machines' scaffolds (GR3), drawn once a machine's scaffold has arrived. The traces are computed
 * again when their data or settings change, and only then, since the chart redraws whatever it is
 * given anew (see `Chart`).
 */
export function GraphChart({
  schema,
  metric,
  machines,
  selected,
  colors,
  scaffold,
  series,
  sampleAgg,
  runAgg,
  busy,
  failed,
}: Props) {
  const { commits, listed } = scaffold
  const displayValue = useMemo(() => {
    const shown = new Map(
      commits.map((commit) => [
        commit.value,
        schema ? commitDisplayValue(commit, schema) : commit.value,
      ]),
    )
    return (value: string) => shown.get(value) ?? value
  }, [commits, schema])

  const data = useMemo(() => {
    if (metric === undefined) return NO_DATA
    const positions = new Map(commits.map((commit, i) => [commit.value, i]))
    const traces: Trace[] = []
    machines.forEach((machine, machineIndex) => {
      // A machine's traces wait for its scaffold, without which their commits have no position.
      if (!listed.has(machine)) return
      const batches = series.batches.filter((batch) => batch.machine === machine)
      for (const test of selected) {
        // A commit's samples may span two pages, so a trace is computed from all of them at once.
        const pages = batches.find((batch) => batch.tests.includes(test))?.pages ?? []
        const measurements = pages.flatMap((page) => page.measurements.get(test) ?? [])
        const points = pointsOf(measurements, positions, sampleAgg, runAgg)
        if (points.length === 0) continue
        traces.push({ test, machine, machineIndex, color: colors.get(test)!, points })
      }
    })
    return traces.length === 0 ? NO_DATA : plotlyTraces(traces, displayValue, metric)
  }, [
    metric,
    commits,
    machines,
    listed,
    series.batches,
    selected,
    colors,
    sampleAgg,
    runAgg,
    displayValue,
  ])

  // What the x-axis is made of: a change resets the zoom (GR5).
  const revision = machines.filter((machine) => listed.has(machine)).join('\0')
  const empty = data.length === 0 && !busy && !failed
  const layout = useMemo(() => {
    const values = commits.map((commit) => commit.value)
    return graphLayout({ commits: values, displayValue, revision, empty })
  }, [commits, displayValue, revision, empty])

  return (
    <Chart
      label={metric ? `${labelOf(metric)} over time` : 'Graph'}
      className={styles.chart}
      data={data}
      layout={layout}
    />
  )
}

const NO_DATA: Data[] = []
