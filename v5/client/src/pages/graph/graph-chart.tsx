import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Data, PlotData, PlotMouseEvent } from 'plotly.js'
import type { Aggregation } from '../../aggregation'
import type { MarkedRegression } from '../../api/regressions'
import type { Scaffold } from '../../api/scaffold'
import type { Measurement, Series } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { colorOfName } from '../../chart-colors'
import { Chart, type PlotGeometry } from '../../components/chart'
import { compareStrings } from '../../format'
import { sameElements } from '../../same-elements'
import { commitDisplayValue, labelOf, type Metric } from '../../schema'
import { useStoreValue, type ValueStore } from '../../value-store'
import type { BaselineState } from './baselines'
import {
  baselineTraces,
  graphLayout,
  markerHeight,
  plotlyTraces,
  regressionMarkers,
  regressionShapes,
  withEmphasis,
  type BaselineLine,
  type PlacedRegression,
  type RegressionMark,
  type Trace,
} from './chart'
import { PointDetails } from './point-details'
import { RegressionDetails } from './regression-details'
import { combineRuns, pointsOf, runValues, type Point } from './points'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema | undefined
  metric: Metric | undefined
  /** The machines plotted, in the order of their chips. */
  machines: readonly string[]
  /** The tests selected, in order. */
  selected: readonly string[]
  scaffold: Scaffold
  series: Series
  sampleAgg: Aggregation
  runAgg: Aggregation
  /** Whether nothing the chart draws is loading or failed to load: an empty chart is empty. */
  settled: boolean
  baselines: BaselineState[]
  /** The regressions to mark (GR15). */
  regressions: MarkedRegression[]
  /** The test whose row is hovered in the test table, which the chart emphasizes (GR7). */
  emphasis: ValueStore<string | null>
  /** Where the chart says which test's line is hovered, for the table to highlight it (GR7). */
  hovered: ValueStore<string | null>
  /**
   * What the chart is drawn from, besides the data: when any of it changes, the point details
   * close (GR11).
   */
  closeOn: readonly unknown[]
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
 * the aggregation change: a page that arrives changes the measurements of its own trace only.
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

/** What a curve of the chart is, for an event on it to be understood. */
type Curve =
  | { kind: 'trace'; trace: Trace }
  | { kind: 'baseline'; test: string }
  | { kind: 'regression'; uuid: string }

/** The test a curve draws, if it draws one. */
function testOf(curve: Curve): string | null {
  if (curve.kind === 'trace') return curve.trace.test
  return curve.kind === 'baseline' ? curve.test : null
}

/** A point of a trace, by the trace's machine and test and the point's commit. */
interface PointKey {
  machine: string
  test: string
  commit: string
}

/** What details are open: a point's (GR11), or a regression's (GR15). */
type Opened = { kind: 'point'; point: PointKey } | { kind: 'regression'; uuid: string }

/** The trace of `key` among `traces`, and the index of its point at `key.commit`, if any. */
function findPoint(traces: Trace[], { machine, test, commit }: PointKey) {
  const trace = traces.find((drawn) => drawn.machine === machine && drawn.test === test)
  const index = trace?.points.findIndex((point) => point.commit === commit) ?? -1
  return trace === undefined || index < 0 ? null : { trace, index }
}

/** The samples of the point of `measurements` at `commit` (GR1). */
function samplesAt(measurements: readonly Measurement[], commit: string) {
  return measurements.filter((measurement) => measurement.commit === commit)
}

/** The values of the runs of `measurements` at `commit`, in the order they were submitted. */
function runsAt(measurements: readonly Measurement[], commit: string, sampleAgg: Aggregation) {
  const runs = runValues(samplesAt(measurements, commit), sampleAgg)
  return runs.sort((a, b) => compareStrings(a.submitted, b.submitted))
}

/**
 * The chart of the Graph page (GR1): a trace per selected test and machine, on the commits of the
 * machines' scaffolds (GR3), drawn once a machine's scaffold has arrived; the baselines' lines
 * (GR9) and the regressions' (GR15) over them. Hovering a point shows its samples (GR10), and
 * clicking it its details (GR11).
 */
export function GraphChart({
  schema,
  metric,
  machines,
  selected,
  scaffold,
  series: latest,
  sampleAgg,
  runAgg,
  settled,
  baselines,
  regressions,
  emphasis,
  hovered,
  closeOn,
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

  const traces = useMemo(() => {
    const drawn: Trace[] = []
    if (metric === undefined) return drawn
    machines.forEach((machine, machineIndex) => {
      // A machine's traces wait for its scaffold, without which their commits have no position.
      if (!listed.has(machine)) return
      for (const test of selected) {
        const measurements = series.measurementsOf(machine, test)
        const points = pointsFor(measurements, positions, sampleAgg, runAgg)
        if (points.length === 0) continue
        drawn.push({ test, machine, machineIndex, color: colorOfName(test), points })
      }
    })
    return drawn
  }, [metric, machines, listed, series, selected, positions, sampleAgg, runAgg])

  // A line per baseline and selected test it has a value for, once all its data has arrived, since
  // a test's samples may span its pages.
  const lines = useMemo(
    () =>
      baselines.flatMap(({ baseline, display, samples }): BaselineLine[] =>
        samples === undefined
          ? []
          : selected.flatMap((test) => {
              const measured = samples.get(test)
              if (measured === undefined) return []
              const value = combineRuns(runValues(measured, sampleAgg), runAgg)
              const { suite, machine } = baseline
              return [{ suite, machine, commit: display, test, value, color: colorOfName(test) }]
            }),
      ),
    [baselines, selected, sampleAgg, runAgg],
  )

  // The regressions whose commit is on the x-axis, each stacked below those at its commit before,
  // and the selected tests each affects.
  const placed = useMemo(() => {
    const stacked = new Map<string, number>()
    return regressions.flatMap((regression): (MarkedRegression & PlacedRegression)[] => {
      const { commit } = regression
      if (!positions.has(commit)) return []
      const stack = stacked.get(commit) ?? 0
      stacked.set(commit, stack + 1)
      return [{ ...regression, stack }]
    })
  }, [regressions, positions])
  const marks = useMemo(
    () =>
      placed.map(
        (regression): RegressionMark => ({
          ...regression,
          tests: selected.filter((test) => regression.tests.has(test)),
        }),
      ),
    [placed, selected],
  )

  // Everything drawn, and what each curve is. Each kind is built apart, so that what changes one
  // does not build the others again: the traces' points are many.
  const traceData = useMemo(
    () => (metric === undefined ? NO_DATA : plotlyTraces(traces, displayValue, metric)),
    [traces, displayValue, metric],
  )
  const lineData = useMemo(
    () => (metric === undefined ? NO_DATA : baselineTraces(lines, metric)),
    [lines, metric],
  )
  const markerData = useMemo(() => regressionMarkers(marks), [marks])
  const drawn = useMemo(
    () => ({
      data: [...traceData, ...lineData, ...markerData],
      curves: [
        ...traces.map((trace): Curve => ({ kind: 'trace', trace })),
        ...lines.map(({ test }): Curve => ({ kind: 'baseline', test })),
        ...marks.map(({ uuid }): Curve => ({ kind: 'regression', uuid })),
      ],
    }),
    [traceData, lineData, markerData, traces, lines, marks],
  )

  // The test hovered in the table, emphasized over the others, as long as it is drawn (GR7). Its
  // traces share their points with those drawn before, so that Plotly only restyles them.
  const emphasized = useStoreValue(emphasis, (test) => test)
  const shown = useMemo(() => {
    const { data, curves } = drawn
    const on = curves.some((curve) => testOf(curve) === emphasized) ? emphasized : null
    const styled =
      on === null
        ? data
        : data.map((trace, i) => {
            const test = testOf(curves[i])
            return test === null ? trace : withEmphasis(trace as Partial<PlotData>, test === on)
          })
    // Plotly reports an event with the trace it drew, which may be one drawn before the latest
    // render, while it is drawing again: an index into the latest curves could be another's.
    const curveOf = new WeakMap(styled.map((trace, i) => [trace as object, curves[i]]))
    return { data: styled, curveOf }
  }, [drawn, emphasized])

  // What the x-axis is made of: a change resets the zoom (GR5).
  const revision = machines.filter((machine) => listed.has(machine)).join('\0')
  // Baselines and regressions are no points of their own (GR12).
  const empty = traces.length === 0 && settled
  const layout = useMemo(() => {
    const values = commits.map((commit) => commit.value)
    return graphLayout({
      commits: values,
      displayValue,
      revision,
      metric: metric?.name,
      empty,
      shapes: regressionShapes(placed),
    })
  }, [commits, displayValue, revision, metric, empty, placed])

  // Where the plot draws, to place the hovered point's samples and the details over it. Nothing
  // drawn depends on it, so that a draw does not ask for another.
  const [geometry, setGeometry] = useState<PlotGeometry | null>(null)
  const [hoveredPoint, setHoveredPoint] = useState<PointKey | null>(null)
  const [open, setOpen] = useState<Opened | null>(null)
  const container = useRef<HTMLDivElement>(null)
  // Closed from the keyboard or its button, the details give the focus back to the chart, rather
  // than to the page; closed by a press elsewhere, they leave it where the press put it.
  const close = useCallback((returnFocus = false) => {
    setOpen(null)
    if (returnFocus) container.current?.focus({ preventScroll: true })
  }, [])
  // Any change to what the chart is drawn from, besides data arriving, closes the details (GR11).
  const [drawnFrom, setDrawnFrom] = useState(closeOn)
  if (!sameElements(drawnFrom, closeOn)) {
    setDrawnFrom(closeOn)
    setOpen(null)
  }

  const curveAt = (event: PlotMouseEvent) => {
    const point = event.points[0]
    const curve = point && shown.curveOf.get(point.data)
    return curve && { curve, index: point.pointNumber }
  }
  const pointOf = (trace: Trace, index: number): PointKey => {
    const { machine, test } = trace
    return { machine, test, commit: trace.points[index].commit }
  }
  const onHover = (event: PlotMouseEvent) => {
    const at = curveAt(event)
    if (at === undefined) return
    if (at.curve.kind === 'trace') setHoveredPoint(pointOf(at.curve.trace, at.index))
    hovered.set(testOf(at.curve))
  }
  const onUnhover = () => {
    setHoveredPoint(null)
    hovered.set(null)
  }
  const onClick = (event: PlotMouseEvent) => {
    const at = curveAt(event)
    // Plotly reports a click of any button: only the main one opens details.
    if (at === undefined || event.event.button !== 0) return
    const { curve } = at
    if (curve.kind === 'trace') setOpen({ kind: 'point', point: pointOf(curve.trace, at.index) })
    if (curve.kind === 'regression') setOpen({ kind: 'regression', uuid: curve.uuid })
  }

  // The samples of the point hovered, if it has several (GR10).
  let scatter = null
  const hoveredAt = hoveredPoint && findPoint(traces, hoveredPoint)
  if (geometry !== null && hoveredAt) {
    const { trace, index } = hoveredAt
    const point = trace.points[index]
    const samples = samplesAt(series.measurementsOf(trace.machine, trace.test), point.commit)
    if (samples.length > 1) {
      const { area } = geometry
      const x = geometry.x(point.position) - area.left
      scatter = (
        <svg
          className={styles.scatter}
          style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
          aria-hidden="true"
        >
          {samples.map((sample, i) => (
            <circle
              key={i}
              cx={x}
              cy={geometry.y(sample.value) - area.top}
              r={4}
              fill={trace.color}
              fillOpacity={0.3}
            />
          ))}
        </svg>
      )
    }
  }

  // The details opened (GR11, GR15), which close once what they are about is no longer drawn.
  const openPoint = open?.kind === 'point' ? findPoint(traces, open.point) : null
  const openMark =
    open?.kind === 'regression' ? marks.find((mark) => mark.uuid === open.uuid) : undefined
  if (open !== null && !openPoint && openMark === undefined) setOpen(null)
  let details = null
  if (geometry !== null && schema !== undefined) {
    const { area } = geometry
    const sideOf = (x: number) => (x < area.left + area.width / 2 ? 'right' : 'left')
    if (openPoint && metric !== undefined) {
      const { trace, index } = openPoint
      const point = trace.points[index]
      const x = geometry.x(point.position)
      details = (
        <PointDetails
          key={`${trace.machine}\0${trace.test}\0${point.commit}`}
          schema={schema}
          metric={metric}
          machine={trace.machine}
          test={trace.test}
          point={point}
          display={displayValue(point.commit)}
          runs={runsAt(series.measurementsOf(trace.machine, trace.test), point.commit, sampleAgg)}
          previous={trace.points[index - 1] ?? null}
          state={series.stateOf(trace.machine, trace.test)}
          sampleAgg={sampleAgg}
          runAgg={runAgg}
          at={{ x, y: geometry.y(point.value), side: sideOf(x) }}
          onClose={close}
        />
      )
    } else if (openMark !== undefined) {
      const { uuid, commit, stack, tests } = openMark
      const x = geometry.x(positions.get(commit)!)
      // On the axis of the markers, which spans the plot from 0 at the bottom to 1 at the top.
      const y = area.top + (1 - markerHeight(stack)) * area.height
      details = (
        <RegressionDetails
          key={uuid}
          schema={schema}
          regression={placed.find((regression) => regression.uuid === uuid)!}
          tests={tests}
          display={displayValue(commit)}
          // Below the marker, at the top of the plot, rather than above the plot.
          at={{ x, y, side: sideOf(x), align: 'start' }}
          onClose={close}
        />
      )
    }
  }

  const label = metric ? `${labelOf(metric)} over time` : 'Graph'
  return (
    <div className={styles.chartArea} ref={container} tabIndex={-1}>
      <Chart
        label={empty ? `${label}: no data to plot` : label}
        className={styles.chart}
        data={shown.data}
        layout={layout}
        onHover={onHover}
        onUnhover={onUnhover}
        onClick={onClick}
        onDraw={setGeometry}
        onRelayout={() => close()}
      />
      {scatter}
      {details}
    </div>
  )
}

const NO_DATA: Data[] = []
