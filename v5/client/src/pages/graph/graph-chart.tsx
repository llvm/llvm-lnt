import { useEffect, useMemo, useRef, useState } from 'react'
import type { Data } from 'plotly.js'
import type { Aggregation } from '../../aggregation'
import type { Scaffold } from '../../api/scaffold'
import type { Measurement, Series } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { Chart } from '../../components/chart'
import { commitDisplayValue, labelOf, type Metric } from '../../schema'
import { graphLayout, plotlyTraces, type Trace } from './chart'
import { pointsOf, type Point } from './points'
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
  /** Whether nothing the chart draws is loading or failed to load: an empty chart is empty. */
  settled: boolean
}

/** How often the chart is drawn again, at most, while data arrives: a redraw draws every trace. */
const REDRAW_INTERVAL_MS = 300

/**
 * `value`, which follows `value` at most once every `interval` milliseconds while `throttled`, the
 * latest one each time, and follows it at once otherwise, or once `key` changes: a value for
 * another key, such as another metric's data, is never shown in place of the latest one.
 */
function useThrottled<T>(value: T, key: string, throttled: boolean, interval: number): T {
  const [shown, setShown] = useState({ value, key })
  const current = throttled && shown.key === key
  if (!current && shown.value !== value) setShown({ value, key })
  const last = useRef(0)
  useEffect(() => {
    if (!throttled) return
    const wait = Math.max(0, last.current + interval - Date.now())
    const timer = setTimeout(() => {
      last.current = Date.now()
      setShown({ value, key })
    }, wait)
    return () => clearTimeout(timer)
  }, [value, key, throttled, interval])
  return current ? shown.value : value
}

/** A trace's points, and what besides its measurements they were computed from. */
interface Computed {
  positions: ReadonlyMap<string, number>
  sampleAgg: Aggregation
  runAgg: Aggregation
  points: Point[]
}

/** What each trace's points were last computed as, by the array of measurements they come from. */
const computed = new WeakMap<readonly Measurement[], Computed>()

/**
 * The points of a trace measured by `measurements`, computed again only when they, the x-axis or
 * the aggregation change: a page that arrives changes the measurements of its batch's tests only.
 */
function pointsFor(
  measurements: readonly Measurement[],
  positions: ReadonlyMap<string, number>,
  sampleAgg: Aggregation,
  runAgg: Aggregation,
): Point[] {
  const known = computed.get(measurements)
  if (
    known !== undefined &&
    known.positions === positions &&
    known.sampleAgg === sampleAgg &&
    known.runAgg === runAgg
  ) {
    return known.points
  }
  const points = pointsOf(measurements, positions, sampleAgg, runAgg)
  computed.set(measurements, { positions, sampleAgg, runAgg, points })
  return points
}

/**
 * The chart of the Graph page (GR1): a trace per selected test and machine, on the commits of the
 * machines' scaffolds (GR3), drawn once a machine's scaffold has arrived.
 */
export function GraphChart({
  schema,
  metric,
  machines,
  selected,
  colors,
  scaffold,
  series: latest,
  sampleAgg,
  runAgg,
  settled,
}: Props) {
  const { commits, listed } = scaffold
  const series = useThrottled(
    latest,
    `${schema?.name}\0${metric?.name}`,
    latest.loading.size > 0,
    REDRAW_INTERVAL_MS,
  )
  const positions = useMemo(() => new Map(commits.map((commit, i) => [commit.value, i])), [commits])
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
    const traces: Trace[] = []
    machines.forEach((machine, machineIndex) => {
      // A machine's traces wait for its scaffold, without which their commits have no position.
      if (!listed.has(machine)) return
      for (const test of selected) {
        const measurements = series.measurementsOf(machine, test)
        const points = pointsFor(measurements, positions, sampleAgg, runAgg)
        if (points.length === 0) continue
        traces.push({ test, machine, machineIndex, color: colors.get(test)!, points })
      }
    })
    return traces.length === 0 ? NO_DATA : plotlyTraces(traces, displayValue, metric)
  }, [
    metric,
    machines,
    listed,
    series,
    selected,
    positions,
    sampleAgg,
    runAgg,
    colors,
    displayValue,
  ])

  // What the x-axis is made of: a change resets the zoom (GR5).
  const revision = machines.filter((machine) => listed.has(machine)).join('\0')
  const empty = data.length === 0 && settled
  const layout = useMemo(() => {
    const values = commits.map((commit) => commit.value)
    return graphLayout({ commits: values, displayValue, revision, metric: metric?.name, empty })
  }, [commits, displayValue, revision, metric, empty])

  const label = metric ? `${labelOf(metric)} over time` : 'Graph'
  return (
    <Chart
      label={empty ? `${label}: no data to plot` : label}
      className={styles.chart}
      data={data}
      layout={layout}
    />
  )
}

const NO_DATA: Data[] = []
