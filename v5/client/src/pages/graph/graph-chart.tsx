import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import type { PlotData, PlotMouseEvent } from 'plotly.js'
import clsx from 'clsx'
import type { Aggregation } from '../../aggregation'
import type { MarkedRegression } from '../../api/regressions'
import type { MachineLabels } from '../../api/machines'
import type { Scaffold } from '../../api/scaffold'
import type { Measurement, Series } from '../../api/series'
import type { Suite } from '../../api/suites'
import { colorOfName } from '../../chart-colors'
import { Chart, type PlotGeometry } from '../../components/chart'
import dialog from '../../components/chart-dialog.module.css'
import { sameElements } from '../../same-elements'
import { commitDisplayValue, labelOf, type Metric } from '../../schema'
import { useStoreValue, type ValueStore } from '../../value-store'
import type { BaselineState } from './baselines'
import {
  baselineTraces,
  circlesAt,
  commitsInView,
  graphLayout,
  highlightCircles,
  highlightShape,
  layoutAxis,
  markerHeight,
  MARKED_COMMITS,
  panelAxes,
  panelsReset,
  panelTitle,
  plotlyTrace,
  regressionMarkers,
  regressionShapes,
  traceMode,
  withEmphasis,
  type BaselineLine,
  type Circled,
  type DisplayValue,
  type PlacedRegression,
  type RegressionMark,
  type Trace,
} from './chart'
import { PointDetails } from './point-details'
import { RegressionDetails } from './regression-details'
import { combineRuns, pointsOf, runSamples, runValues, type Point } from './points'
import { SampleCloud, type Pinned } from './sample-cloud'
import styles from './graph.module.css'

interface Props {
  schema: Suite | undefined
  /** The metrics plotted, a panel each, in the order of their chips (GR1). */
  metrics: readonly Metric[]
  /** The machines plotted, in the order of their chips. */
  machines: readonly string[]
  /** The label of each machine of the suite (AR23). */
  labelOfMachine: MachineLabels
  /** The tests selected, in order. */
  selected: readonly string[]
  scaffold: Scaffold
  series: Series
  sampleAgg: Aggregation
  runAgg: Aggregation
  /**
   * Whether nothing the chart draws is loading or failed to load, but for each metric's test lists
   * (`unlisted`) and measurements (`Series.unsettled`): an empty panel is empty.
   */
  settled: boolean
  /** The metrics whose test lists are still loading on some machine, or could not be loaded. */
  unlisted: ReadonlySet<string>
  baselines: BaselineState[]
  /** The regressions to mark (GR15). */
  regressions: MarkedRegression[]
  /** The highlighted commits on the x-axis (GR16). */
  highlights: readonly string[]
  /** Why no other commit can be highlighted, if as many are as can be (GR16). */
  highlightsFull: string | undefined
  /** Highlight `commit`, or remove its highlight if it is highlighted already (GR16). */
  onHighlight(commit: string): void
  /** Whether `commit` of `machine`, in the suite plotted, is a baseline (GR9). */
  isBaseline(machine: string, commit: string): boolean
  /** Add `commit` of `machine`, in the suite plotted, as a baseline, or remove it if it is one. */
  onBaseline(machine: string, commit: string): void
  /** The test whose row is hovered in the test table, which the chart emphasizes (GR7). */
  emphasis: ValueStore<string | null>
  /** Where the chart says which test's line is hovered, for the table to highlight it (GR7). */
  hovered: ValueStore<string | null>
  /**
   * What the chart is drawn from, besides the data, the baselines and the highlighted commits: when
   * any of it changes, the details close (GR11).
   */
  closeOn: readonly unknown[]
}

/** How often the chart is drawn again, at most, while data arrives: a redraw draws every trace. */
const REDRAW_INTERVAL_MS = 300

/**
 * `value`, which follows `value` at most once every `interval` milliseconds while `throttled`, the
 * latest one each time, and follows it at once otherwise, or once `key` changes: a value for
 * another key, such as other metrics' data, is never shown in place of the latest one.
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
 * the aggregation change: a trace whose data arrives changes its own measurements only.
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

/** A trace's data for Plotly, but for its mode, and what it was built from besides the store's. */
interface BuiltTrace {
  metric: Metric
  points: Point[]
  machineIndex: number
  machineLabel: string
  data: Partial<PlotData>
}

/**
 * The traces' data for Plotly, but for their mode, which changes with the zoom: each trace's is
 * built again only when what it is built from changes, since building every trace's tooltips each
 * time the chart is drawn again, as data arrives, costs as much as drawing them. Only the traces last
 * built are kept.
 */
class TraceStore {
  private built = new Map<string, BuiltTrace>()
  private displayValue: DisplayValue | null = null

  build(traces: Trace[], displayValue: DisplayValue): Partial<PlotData>[] {
    if (displayValue !== this.displayValue) this.built.clear()
    this.displayValue = displayValue
    const kept = new Map<string, BuiltTrace>()
    const data = traces.map((trace) => {
      // By test, which gives the trace's colour too (GR1).
      const key = `${trace.metric.name}\0${trace.machine}\0${trace.test}`
      const known = this.built.get(key)
      const { metric, points, machineIndex, machineLabel } = trace
      const entry =
        known?.points === points &&
        known.metric === metric &&
        known.machineIndex === machineIndex &&
        known.machineLabel === machineLabel
          ? known
          : { metric, points, machineIndex, machineLabel, data: plotlyTrace(trace, displayValue) }
      kept.set(key, entry)
      return entry.data
    })
    this.built = kept
    return data
  }
}

/** What a curve of the chart is, for an event on it to be understood. */
type Curve =
  | { kind: 'trace'; trace: Trace }
  | { kind: 'circle'; test: string }
  | { kind: 'baseline'; test: string }
  | { kind: 'regression'; uuid: string; metric: string }

/** The test a curve draws, or marks, if any: a circle fades with its trace (GR7, GR16). */
function testOf(curve: Curve): string | null {
  if (curve.kind === 'trace') return curve.trace.test
  return curve.kind === 'circle' || curve.kind === 'baseline' ? curve.test : null
}

/** A point of a trace, by the trace's metric, machine and test and the point's commit. */
interface PointKey {
  metric: string
  machine: string
  test: string
  commit: string
}

/** What details are open: a point's (GR11), or a regression's in a metric's panel (GR15). */
type Opened =
  | { kind: 'point'; point: PointKey }
  | { kind: 'regression'; uuid: string; metric: string }

/** A point drawn: its trace, and its index among the trace's points. */
interface PointAt {
  trace: Trace
  index: number
}

/** The trace of `key` among `traces`, and the index of its point at `key.commit`, if any. */
function findPoint(traces: Trace[], { metric, machine, test, commit }: PointKey): PointAt | null {
  const trace = traces.find(
    (drawn) => drawn.metric.name === metric && drawn.machine === machine && drawn.test === test,
  )
  const index = trace?.points.findIndex((point) => point.commit === commit) ?? -1
  return trace === undefined || index < 0 ? null : { trace, index }
}

/** The samples of the point of `measurements` at `commit` (GR1). */
function samplesAt(measurements: readonly Measurement[], commit: string) {
  return measurements.filter((measurement) => measurement.commit === commit)
}

/** The runs of `samples`, in the order they were measured, each with its own ascending (GR11). */
function runsOf(samples: readonly Measurement[]) {
  const runs = runSamples(samples)
  for (const run of runs) run.samples.sort((a, b) => a - b)
  // By instant rather than as strings: a timestamp is written with a fraction of a second only when
  // it has one, so the strings of two instants a fraction apart need not sort in their order.
  return runs.sort((a, b) => Date.parse(a.measured) - Date.parse(b.measured))
}

/**
 * Where the `panel`th panel of a plot drawn as `geometry` says draws: its part of the plotting
 * area, and the position of a value on its y-axis; or null until a plot with that panel is drawn.
 */
function panelGeometry(geometry: PlotGeometry, panel: number): PlotGeometry | null {
  const axis = geometry.yAxes.get(layoutAxis(panelAxes(panel).values))
  if (axis === undefined) return null
  const { top, height, y } = axis
  return { ...geometry, area: { ...geometry.area, top, height }, y }
}

/**
 * The chart of the Graph page (GR1): a panel per metric, stacked, each with a trace per selected
 * test and machine, on the commits of the machines' scaffolds (GR3), drawn once a machine's
 * scaffold has arrived; the highlighted commits' bands (GR16) and the regressions' lines (GR15)
 * under them, and the baselines' lines (GR9), the highlighted commits' circles and the regressions'
 * markers over them. Hovering a point shows its samples (GR10) and a line across the panels at its
 * commit, and clicking it its details (GR11).
 */
export function GraphChart({
  schema,
  metrics,
  machines,
  labelOfMachine,
  selected,
  scaffold,
  series: latest,
  sampleAgg,
  runAgg,
  settled,
  unlisted,
  baselines,
  regressions,
  highlights,
  highlightsFull,
  onHighlight,
  isBaseline,
  onBaseline,
  emphasis,
  hovered,
  closeOn,
}: Props) {
  const { commits, listed } = scaffold
  const series = useThrottled(
    latest,
    [schema?.name, ...metrics.map((metric) => metric.name)].join('\0'),
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
    metrics.forEach((metric, panel) => {
      machines.forEach((machine, machineIndex) => {
        // A machine's traces wait for its scaffold, without which their commits have no position.
        if (!listed.has(machine)) return
        for (const test of selected) {
          const measurements = series.measurementsOf(metric.name, machine, test)
          const points = pointsFor(measurements, positions, sampleAgg, runAgg)
          if (points.length === 0) continue
          drawn.push({
            metric,
            panel,
            test,
            machine,
            machineLabel: labelOfMachine(machine),
            machineIndex,
            color: colorOfName(test),
            points,
          })
        }
      })
    })
    return drawn
  }, [metrics, machines, labelOfMachine, listed, series, selected, positions, sampleAgg, runAgg])

  // In each panel, a line per baseline drawn there and selected test it has a value for, once that
  // test's data has arrived.
  const lines = useMemo(
    () =>
      metrics.flatMap((metric, panel) =>
        baselines.flatMap(({ suiteLabel, machineLabel, display, label, samples }) => {
          const ofMetric = samples.get(metric.name)
          if (ofMetric === undefined) return []
          return selected.flatMap((test): BaselineLine[] => {
            const measured = ofMetric.get(test)
            if (measured === undefined) return []
            const value = combineRuns(runValues(measured, sampleAgg), runAgg)
            return [
              {
                metric,
                panel,
                label,
                suiteLabel,
                machineLabel,
                commit: display,
                test,
                value,
                color: colorOfName(test),
              },
            ]
          })
        }),
      ),
    [metrics, baselines, selected, sampleAgg, runAgg],
  )

  // The regressions whose commit is on the x-axis, in the panel of the metric each is marked for,
  // each stacked below those at its commit in its panel before, and the selected tests each
  // affects.
  const placed = useMemo(() => {
    const stacked = new Map<string, number>()
    return regressions.flatMap((regression): (MarkedRegression & PlacedRegression)[] => {
      const { commit } = regression
      const panel = metrics.findIndex((metric) => metric.name === regression.metric)
      if (panel < 0 || !positions.has(commit)) return []
      const at = `${panel}\0${commit}`
      const stack = stacked.get(at) ?? 0
      stacked.set(at, stack + 1)
      return [{ ...regression, panel, stack }]
    })
  }, [regressions, metrics, positions])
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

  // The points at the highlighted commits (GR16).
  const circles = useMemo(
    () => (highlights.length === 0 ? NO_CIRCLES : circlesAt(traces, highlights)),
    [traces, highlights],
  )

  // What the x-axis is made of: a change resets the zoom (GR5).
  const revision = machines.filter((machine) => listed.has(machine)).join('\0')
  // Where the plot draws, to place the points' samples and the details over it, and the x-axis it
  // was drawn with.
  const [drawnAt, setDrawnAt] = useState<{ geometry: PlotGeometry; revision: string } | null>(
    null,
  )
  const geometry = drawnAt?.geometry ?? null
  // The points have markers while few enough commits are in view (GR1): all of them, until the plot
  // is drawn with this x-axis. A draw changes how many only with the zoom, so that drawing the
  // markers or not asks for no other draw.
  const inView =
    drawnAt?.revision === revision
      ? commitsInView(drawnAt.geometry, commits.length)
      : commits.length
  const markers = inView <= MARKED_COMMITS
  const [traceStore] = useState(() => new TraceStore())

  // Everything drawn, and what each curve is. Each kind is built apart, so that what changes one
  // does not build the others again: the traces' points are many.
  const built = useMemo(
    () => traceStore.build(traces, displayValue),
    [traceStore, traces, displayValue],
  )
  const traceData = useMemo(
    () =>
      built.map((data, i) => {
        const { points, panel } = traces[i]
        return { ...data, mode: traceMode(points.length, markers), yaxis: panelAxes(panel).values }
      }),
    [built, traces, markers],
  )
  const lineData = useMemo(() => baselineTraces(lines), [lines])
  const circleData = useMemo(() => highlightCircles(circles), [circles])
  const markerData = useMemo(() => regressionMarkers(marks), [marks])
  const drawn = useMemo(
    () => ({
      // The baselines' lines before the traces, though drawn over them on their own x-axis: of the
      // curves as close to the pointer, Plotly hovers the last, so a point on a line keeps its
      // tooltip and details (GR9). It is as close as can be anywhere over its marker; without one,
      // wherever the pointer is no closer to the line's nearest point, which are about 10 pixels
      // apart. The circles over every trace, so that no trace's line crosses them.
      data: [...lineData, ...traceData, ...circleData, ...markerData],
      curves: [
        ...lines.map(({ test }): Curve => ({ kind: 'baseline', test })),
        ...traces.map((trace): Curve => ({ kind: 'trace', trace })),
        ...circles.map(({ trace }): Curve => ({ kind: 'circle', test: trace.test })),
        ...marks.map(({ uuid, metric }): Curve => ({ kind: 'regression', uuid, metric })),
      ],
    }),
    [traceData, circleData, lineData, markerData, traces, circles, lines, marks],
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

  // The panels, or a single one without a metric before any is chosen (GR1), each empty when it has
  // no point to draw, and none of its metric's test lists or measurements is loading or failed to
  // load -- the measurements drawn, throttled as they are (GR12). Baselines, regressions and the
  // highlighted commits are no points of their own. The metrics loading are compared by name, so
  // that a new set of the same ones does not draw the chart again.
  const unsettled = [...new Set([...unlisted, ...series.unsettled])].sort().join('\0')
  const panels = useMemo(() => {
    const loading = new Set(unsettled.split('\0'))
    const emptyIn = (panel: number) => settled && !traces.some((trace) => trace.panel === panel)
    if (metrics.length === 0) return [{ metric: undefined, title: null, empty: emptyIn(0) }]
    return metrics.map((metric, panel) => ({
      metric: metric.name,
      title: panelTitle(metric),
      empty: emptyIn(panel) && !loading.has(metric.name),
    }))
  }, [metrics, traces, settled, unsettled])
  const layout = useMemo(() => {
    const values = commits.map((commit) => commit.value)
    return graphLayout({
      commits: values,
      displayValue,
      revision,
      panels,
      // The bands first, so that a regression's line at their commit is drawn over them (GR16).
      shapes: [...highlights.map(highlightShape), ...regressionShapes(placed)],
    })
  }, [commits, displayValue, revision, panels, placed, highlights])
  const doubleClickReset = useMemo(() => panelsReset(panels.length), [panels.length])

  const [hoveredPoint, setHoveredPoint] = useState<PointKey | null>(null)
  const [open, setOpen] = useState<Opened | null>(null)
  // The samples of the point whose details are open, a press on which leaves them open (GR11).
  const pinnedCloud = useRef<SVGSVGElement>(null)
  const close = useCallback(() => setOpen(null), [])
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
    const { metric, machine, test } = trace
    return { metric: metric.name, machine, test, commit: trace.points[index].commit }
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
  // Whether the click opened details, which take the place of the hover label (GR11, GR15).
  const onClick = (event: PlotMouseEvent) => {
    const at = curveAt(event)
    // Plotly reports a click of any button: only the main one opens details.
    if (at === undefined || event.event.button !== 0) return false
    const { curve } = at
    if (curve.kind === 'trace') setOpen({ kind: 'point', point: pointOf(curve.trace, at.index) })
    else if (curve.kind === 'regression') setOpen({ ...curve })
    else return false
    return true
  }

  // The details opened (GR11, GR15), which close once what they are about is no longer drawn.
  const openPoint = open?.kind === 'point' ? findPoint(traces, open.point) : null
  const openMark =
    open?.kind === 'regression'
      ? marks.find((mark) => mark.uuid === open.uuid && mark.metric === open.metric)
      : undefined
  if (open !== null && !openPoint && openMark === undefined) setOpen(null)
  const hoveredAt = hoveredPoint && findPoint(traces, hoveredPoint)
  const clouds: ReactNode[] = []
  let hoverLine = null
  let details = null
  if (geometry !== null) {
    const { area } = geometry
    const sideOf = (x: number) => (x < area.left + area.width / 2 ? 'right' : 'left')
    const keyOf = ({ trace, index }: PointAt) =>
      `${trace.metric.name}\0${trace.machine}\0${trace.test}\0${trace.points[index].commit}`
    const samplesOf = ({ trace, index }: PointAt) =>
      samplesAt(
        series.measurementsOf(trace.metric.name, trace.machine, trace.test),
        trace.points[index].commit,
      )
    // The samples of a point, if it has several (GR10), in its panel.
    const cloud = (at: PointAt, samples: Measurement[], pinned?: Pinned) => {
      const { trace, index } = at
      const inPanel = panelGeometry(geometry, trace.panel)
      if (samples.length < 2 || inPanel === null) return
      clouds.push(
        <SampleCloud
          key={keyOf(at)}
          samples={samples}
          geometry={inPanel}
          position={trace.points[index].position}
          color={trace.color}
          pinned={pinned}
        />,
      )
    }
    if (hoveredAt) {
      // The point hovered's, unless its details are open, which show them already.
      if (!openPoint || keyOf(hoveredAt) !== keyOf(openPoint)) {
        cloud(hoveredAt, samplesOf(hoveredAt))
      }
      // A line across every panel at its commit, to find it in the others (GR10).
      const x = geometry.x(hoveredAt.trace.points[hoveredAt.index].position)
      hoverLine = (
        <div
          className={styles.hoverLine}
          style={{ left: x, top: area.top, height: area.height }}
          aria-hidden="true"
        />
      )
    }
    // The panel of the details open, which are placed in it.
    const openIn = openPoint ? openPoint.trace.panel : openMark?.panel
    const inPanel = openIn === undefined ? null : panelGeometry(geometry, openIn)
    if (schema !== undefined && inPanel !== null) {
      if (openPoint) {
        const { trace, index } = openPoint
        const { metric } = trace
        const point = trace.points[index]
        const x = geometry.x(point.position)
        const side = sideOf(x)
        const samples = samplesOf(openPoint)
        // The open point's, as long as its details are open.
        cloud(openPoint, samples, { metric, details: side, ref: pinnedCloud })
        details = (
          <PointDetails
            key={keyOf(openPoint)}
            schema={schema}
            metric={metric}
            machine={trace.machine}
            machineLabel={trace.machineLabel}
            test={trace.test}
            point={point}
            commit={commits[point.position]}
            runs={runsOf(samples)}
            previous={index > 0 ? commits[trace.points[index - 1].position] : null}
            sampleAgg={sampleAgg}
            runAgg={runAgg}
            highlighted={highlights.includes(point.commit)}
            highlightsFull={highlightsFull}
            onHighlight={() => onHighlight(point.commit)}
            baselined={isBaseline(trace.machine, point.commit)}
            onBaseline={() => onBaseline(trace.machine, point.commit)}
            at={{ x, y: inPanel.y(point.value), side }}
            companion={pinnedCloud}
            onClose={close}
          />
        )
      } else if (openMark !== undefined) {
        const { uuid, metric, commit, stack, tests } = openMark
        const position = positions.get(commit)!
        const x = geometry.x(position)
        // On the axis of the markers, which spans the panel from 0 at the bottom to 1 at the top.
        const { top, height } = inPanel.area
        const y = top + (1 - markerHeight(stack)) * height
        details = (
          <RegressionDetails
            key={`${uuid}\0${metric}`}
            schema={schema}
            regression={
              placed.find((placed) => placed.uuid === uuid && placed.metric === metric)!
            }
            commit={commits[position]}
            tests={tests}
            // Below the marker, at the top of its panel, rather than above the panel.
            at={{ x, y, side: sideOf(x), align: 'start' }}
            onClose={close}
          />
        )
      }
    }
  }

  const label =
    metrics.length === 0 ? 'Graph' : `${metrics.map(labelOf).join(', ')} over time`
  const empty = panels.every((panel) => panel.empty)
  return (
    <div
      className={clsx(styles.chartArea, dialog.host)}
      // How tall the chart is: the taller for each panel (GR1).
      style={{ '--panels': panels.length } as CSSProperties}
      tabIndex={-1}
    >
      <Chart
        label={empty ? `${label}: no data to plot` : label}
        className={styles.chart}
        data={shown.data}
        layout={layout}
        onHover={onHover}
        onUnhover={onUnhover}
        onClick={onClick}
        onDraw={(where) => setDrawnAt({ geometry: where, revision })}
        onRelayout={close}
        // Plotly resets the panel double-clicked, which is all of a single one.
        doubleClickReset={panels.length > 1 ? doubleClickReset : undefined}
      />
      {hoverLine}
      {clouds}
      {details}
    </div>
  )
}

const NO_CIRCLES: Circled[] = []
