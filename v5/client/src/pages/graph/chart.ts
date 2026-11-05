/**
 * What the Graph page's chart draws (GR1, GR3, GR5, GR7, GR9, GR10, GR12, GR15, GR16), computed
 * apart from the chart that draws it.
 */

import type { Data, DTickValue, Layout, LayoutAxis, PlotData, Shape, YAxisName } from 'plotly.js'
import { markerOf } from '../../chart-markers'
import type { PlotGeometry } from '../../components/chart'
import { noDataAnnotations } from '../../components/plot-annotations'
import { escapeHtml, plural, regressionTitle } from '../../format'
import type { RegressionState } from '../../regression-states'
import { formatMeasuredValue, labelOf, shortUnit, type Metric } from '../../schema'
import type { Point } from './points'

/**
 * An axis over `axis` spanning its part of the plot from 0 to 1 whatever its zoom, which is not
 * shown.
 */
function overlayAxis(axis: LayoutAxis['overlaying']): Partial<LayoutAxis> {
  return { overlaying: axis, range: [0, 1], fixedrange: true, visible: false }
}

/**
 * The y-axes of the `panel`th panel of the chart, from 0 at the top (GR1): the axis of its values,
 * and the one its regressions' markers are placed on (GR15), which spans the panel from 0 to 1. The
 * first panel's are `y` and `y2`, the second's `y3` and `y4`, and so on.
 */
export function panelAxes(panel: number): { values: YAxisName; markers: YAxisName } {
  // Plotly's types name at most 99 axes, which is beyond what a template of a number can tell.
  const axis = (n: number) => (n === 1 ? 'y' : `y${n}`) as YAxisName
  return { values: axis(2 * panel + 1), markers: axis(2 * panel + 2) }
}

/** The name of the y-axis `axis` (`y3`, say) in a layout, and in a plot's geometry: `yaxis3`. */
export function layoutAxis(axis: string): string {
  return `yaxis${axis.slice(1)}`
}

/** A metric's value, labelled with the metric, as the chart's tooltips show it (GR10). */
function labelledValue(value: number, metric: Metric): string {
  return `${escapeHtml(labelOf(metric))}: ${escapeHtml(formatMeasuredValue(value, metric))}`
}

/** One test on one machine, in the panel of one metric, as the chart draws it. */
export interface Trace {
  /** The metric of the trace's panel, and the panel's position, from 0 at the top. */
  metric: Metric
  panel: number
  test: string
  /** The machine's name, which tells the trace apart from another machine's of the same label. */
  machine: string
  /** The machine's label, which names the trace (AR23). */
  machineLabel: string
  /** The machine's position among the chips, which gives its marker. */
  machineIndex: number
  color: string
  points: Point[]
}

/** The text a chart shows of a commit: its display value (AR6). */
export type DisplayValue = (commit: string) => string

/**
 * At most how many commits of the x-axis can be in view for the traces' points to have markers
 * (GR1). Beyond, the markers are too close together to tell apart, and drawing one per point is
 * what makes a large selection slow to draw.
 */
export const MARKED_COMMITS = 200

/**
 * How many of the `count` commits of the x-axis are in view in a plot drawn as `geometry` says: the
 * positions from 0 to `count - 1` between the left and right edges of the plot. Plotly rounds the
 * pixels of a position, so the step between two is taken across the whole axis, lest its error add
 * up far from position 0. Rounding can still make the count one off at an edge.
 */
export function commitsInView({ area, x }: PlotGeometry, count: number): number {
  const span = Math.max(count - 1, 1)
  const step = (x(span) - x(0)) / span
  const first = Math.max(0, Math.ceil((area.left - x(0)) / step))
  const last = Math.min(count - 1, Math.floor((area.left + area.width - x(0)) / step))
  return Math.max(0, last - first + 1)
}

/**
 * How a trace of `points` points is drawn: a line with a marker at each point, or the line alone
 * when the points have no `markers` (see `MARKED_COMMITS`). A single point keeps its marker, without
 * which it would draw nothing.
 */
export function traceMode(points: number, markers: boolean): 'lines' | 'lines+markers' {
  return markers || points === 1 ? 'lines+markers' : 'lines'
}

/**
 * A trace as Plotly draws it, but for its `mode` (see `traceMode`), which changes with the zoom,
 * and its panel's y-axis (see `panelAxes`), which changes with the metrics before it: a line
 * through its points, placed on the x-axis by commit, its markers in the symbol of its machine,
 * and a tooltip naming the test, the machine and the commit, giving the value, labelled with the
 * metric, and how many runs it combines, and saying that a click shows the point's details
 * (GR10). Text from the API is escaped and passed as data rather than written into
 * the template (see chart.tsx).
 */
export function plotlyTrace(
  { metric, test, machineLabel, machineIndex, color, points }: Trace,
  displayValue: DisplayValue,
): Partial<PlotData> {
  const escapedTest = escapeHtml(test)
  const escapedMachine = escapeHtml(machineLabel)
  return {
    type: 'scatter',
    name: `${escapedTest} - ${escapedMachine}`,
    x: points.map((point) => point.commit),
    y: points.map((point) => point.value),
    customdata: points.map((point) => [
      escapeHtml(displayValue(point.commit)),
      labelledValue(point.value, metric),
      plural(point.runs, 'run'),
      escapedTest,
      escapedMachine,
    ]),
    hovertemplate:
      '<b>%{customdata[3]}</b><br>Machine: %{customdata[4]}<br>' +
      'Commit: %{customdata[0]}<br>%{customdata[1]} (%{customdata[2]})<br>' +
      '<i>Click for details</i><extra></extra>',
    line: { color, width: 1.5 },
    // With `maxdisplayed`, Plotly draws only the markers of the points in view (x and y in range),
    // rather than every point's, and only that many of them, evenly spaced, when more are in view.
    // While the points have markers, about MARKED_COMMITS are in view at most, give or take one (see
    // `commitsInView`): with room to spare, Plotly leaves out the points out of view, but never
    // thins out those in view.
    marker: {
      color,
      size: 6,
      symbol: markerOf(machineIndex).symbol,
      maxdisplayed: 2 * MARKED_COMMITS,
    },
  }
}

/**
 * `trace`, emphasized as the test hovered in the test table (GR7) when `emphasized`, and faded
 * otherwise, sharing its points with `trace` so that Plotly need not compute them again.
 */
export function withEmphasis(trace: Partial<PlotData>, emphasized: boolean): Partial<PlotData> {
  return emphasized ? { ...trace, line: { ...trace.line, width: 3 } } : { ...trace, opacity: 0.2 }
}

/** A baseline's line for one test, in the panel of one metric (GR9). */
export interface BaselineLine {
  metric: Metric
  panel: number
  /** How the baseline is named (see `BaselineState`). */
  label: string
  /** The full label of the baseline's suite (AR22). */
  suiteLabel: string
  /** The label of the baseline's machine (AR23). */
  machineLabel: string
  /** The display value of the baseline's commit. */
  commit: string
  test: string
  value: number
  color: string
}

/** How many points a line drawn across the chart has: as many places to hover it from. */
const ACROSS = 101

/** The positions of the points of a line across the chart, on an axis spanning 0 to 1. */
const SPAN = Array.from({ length: ACROSS }, (_, i) => i / (ACROSS - 1))

/**
 * The baselines' lines (GR9): one dashed line per baseline and test in its panel, across the whole
 * width of the chart at any zoom, on an x-axis of their own spanning 0 to 1. Their points are along
 * that axis, however many commits the chart has, so that the line can be hovered from anywhere
 * along it.
 */
export function baselineTraces(lines: BaselineLine[]): Data[] {
  return lines.map((line) => {
    const { metric, panel, label, suiteLabel, machineLabel, commit, test, value, color } = line
    const tooltip = [
      ...[suiteLabel, machineLabel, commit, test].map(escapeHtml),
      labelledValue(value, metric),
    ]
    return {
      type: 'scatter',
      mode: 'lines',
      name: `${escapeHtml(test)} - baseline ${escapeHtml(label)}`,
      xaxis: 'x2',
      yaxis: panelAxes(panel).values,
      x: SPAN,
      y: SPAN.map(() => value),
      customdata: SPAN.map(() => tooltip),
      hovertemplate:
        '<b>Baseline</b><br>Suite: %{customdata[0]}<br>Machine: %{customdata[1]}<br>' +
        'Commit: %{customdata[2]}<br>Test: %{customdata[3]}<br>' +
        '%{customdata[4]}<extra></extra>',
      line: { color, width: 1.5, dash: 'dash' },
    }
  })
}

/** A regression placed on the chart, in the panel of one metric (GR15). */
export interface PlacedRegression {
  /** The metric it is marked for, and the position of its panel, from 0 at the top. */
  metric: string
  panel: number
  uuid: string
  title: string | null
  state: RegressionState
  /** The commit it is attributed to, which is on the x-axis. */
  commit: string
  /** Its place among the regressions at its commit, from 0: where its marker is stacked. */
  stack: number
}

/**
 * The height of the marker of the regression `stack`th at its commit in its panel, on the axis of
 * the markers, which spans the panel from 0 at the bottom to 1 at the top. The lowest stays inside
 * the panel, however many share a commit.
 */
export function markerHeight(stack: number): number {
  return Math.max(0.02, 0.98 - 0.05 * stack)
}

/** A regression drawn on the chart (GR15), with the selected tests it affects. */
export interface RegressionMark extends PlacedRegression {
  tests: string[]
}

/** The colour of a regression's line and marker, by its state (GR15). */
export function stateColor(state: RegressionState): string {
  switch (state) {
    case 'active':
      return '#dc2626'
    case 'detected':
      return '#ca8a04'
    default:
      return '#6b7280'
  }
}

/** At most how many of the tests a regression affects its tooltip names (GR15). */
const TESTS_NAMED = 10

/**
 * The regressions' lines (GR15): a dashed vertical line across its panel at each regression's
 * commit, which is not hovered, so that the points along it can be.
 */
export function regressionShapes(
  marks: Pick<PlacedRegression, 'panel' | 'commit' | 'state'>[],
): Partial<Shape>[] {
  return marks.map(({ panel, commit, state }) => ({
    type: 'line',
    xref: 'x',
    // Across the panel whatever its zoom: a reference to the axis's domain.
    yref: `${panelAxes(panel).values} domain` as Shape['yref'],
    x0: commit,
    x1: commit,
    y0: 0,
    y1: 1,
    layer: 'below',
    line: { color: stateColor(state), width: 1.5, dash: 'dash' },
  }))
}

/**
 * A marker at the top of each regression's line (GR15), which is what is hovered, and clicked for
 * the regression's details: one per regression and panel, stacked downwards when several share a
 * commit, on a y-axis of their panel's own spanning 0 to 1, so that they neither take part in the
 * scale of the values nor move with a zoom.
 */
export function regressionMarkers(marks: RegressionMark[]): Data[] {
  return marks.map(({ panel, uuid, title, state, commit, tests, stack }) => {
    const named = tests.slice(0, TESTS_NAMED).map(escapeHtml).join('<br>')
    const more = tests.length > TESTS_NAMED ? `<br>and ${tests.length - TESTS_NAMED} more` : ''
    return {
      type: 'scatter',
      mode: 'markers',
      name: `regression ${uuid}`,
      yaxis: panelAxes(panel).markers,
      x: [commit],
      y: [markerHeight(stack)],
      customdata: [[escapeHtml(regressionTitle({ title })), `${named}${more}`]],
      hovertemplate:
        '<b>%{customdata[0]}</b><br>Affects:<br>%{customdata[1]}<br>' +
        '<i>Click for details</i><extra></extra>',
      marker: { color: stateColor(state), size: 10, symbol: 'triangle-down' },
    }
  })
}

/** The highlighted commits' bands (GR16): a light blue, unlike any regression's colour (GR15). */
const BAND_COLOR = 'rgba(37, 99, 235, 0.18)'

/** How wide the band is, in pixels, whatever the zoom. */
const BAND_WIDTH = 12

/**
 * The band at a highlighted commit (GR16): a see-through rectangle across the plot, every panel
 * included, a fixed number of pixels wide around the commit, under the traces.
 */
export function highlightShape(commit: string): Partial<Shape> {
  return {
    type: 'rect',
    xref: 'x',
    xsizemode: 'pixel',
    xanchor: commit,
    x0: -BAND_WIDTH / 2,
    x1: BAND_WIDTH / 2,
    yref: 'paper',
    y0: 0,
    y1: 1,
    layer: 'below',
    fillcolor: BAND_COLOR,
    line: { width: 0 },
  }
}

/** A trace's points at the highlighted commits (GR16). */
export interface Circled {
  trace: Trace
  points: Point[]
}

/** The points of each of `traces` at `commits`, for those that have any (GR16). */
export function circlesAt(traces: Trace[], commits: readonly string[]): Circled[] {
  return traces.flatMap((trace) => {
    const points = trace.points.filter((point) => commits.includes(point.commit))
    return points.length === 0 ? [] : [{ trace, points }]
  })
}

/**
 * An open circle around each point at a highlighted commit (GR16), in its trace's colour, which is
 * not hovered, nor therefore clicked, so that the point under it keeps its tooltip and details: one
 * scatter per trace circled. Its markers are not clipped to the plot, so that a circle at either end
 * of the x-axis shows whole: Plotly still leaves out a point outside the range.
 */
export function highlightCircles(circles: Circled[]): Data[] {
  return circles.map(({ trace, points }) => ({
    type: 'scatter',
    mode: 'markers',
    name: `${escapeHtml(trace.test)} - ${escapeHtml(trace.machineLabel)} - highlighted`,
    yaxis: panelAxes(trace.panel).values,
    x: points.map((point) => point.commit),
    y: points.map((point) => point.value),
    hoverinfo: 'skip',
    cliponaxis: false,
    // An open symbol is drawn in the marker's colour, with the width of its line.
    marker: { color: trace.color, size: 14, symbol: 'circle-open', line: { width: 2 } },
  }))
}

/** What the layout needs of a panel of the chart (GR1). */
export interface PanelLayout {
  /** The name of its metric, whose change at the panel's place resets a zoom of its y-axis. */
  metric: string | undefined
  /** The title of its y-axis, if any. */
  title: string | null
  /** Whether to say that the panel has nothing to plot (GR12). */
  empty: boolean
}

interface LayoutOptions {
  /** The commit values of the x-axis, in ordinal order (GR3). */
  commits: string[]
  displayValue: DisplayValue
  /**
   * What the x-axis is made of, such as the machines whose scaffold it holds: a new value resets
   * what the user did to the chart (GR5).
   */
  revision: string
  /** The panels, from the top, at least one. */
  panels: PanelLayout[]
  /** The highlighted commits' bands and the regressions' lines (GR15, GR16). */
  shapes?: Partial<Shape>[]
}

/** The space between two panels, as a fraction of the height of the plot. */
const PANEL_GAP = 0.04

/**
 * The part of the plot's height the `panel`th of `count` panels spans, from 0 at the bottom to 1 at
 * the top, the first at the top: they are as tall as one another.
 */
function panelDomain(panel: number, count: number): [number, number] {
  const height = (1 - PANEL_GAP * (count - 1)) / count
  const top = 1 - panel * (height + PANEL_GAP)
  // Clamped, so that the bottom panel ends at 0 exactly, whatever the rounding errors.
  return [Math.max(0, top - height), top]
}

/**
 * The chart's layout. The x-axis is a category per commit of the scaffold, in ordinal order,
 * labelled with each one's display value and spanning all of them whatever the traces cover, so
 * that it neither moves as data arrives (GR3) nor merges two commits that share a display value
 * (GR1). The panels share it, labelled under the bottom one, each with a y-axis of its own (GR1).
 * It has no legend of its own: the test table and the machines' chips are one (GR7).
 */
export function graphLayout({
  commits,
  displayValue,
  revision,
  panels,
  shapes = [],
}: LayoutOptions): Partial<Layout> {
  const axes: Record<string, Partial<LayoutAxis>> = {}
  panels.forEach(({ metric, title }, i) => {
    const { values, markers } = panelAxes(i)
    axes[layoutAxis(values)] = {
      domain: panelDomain(i, panels.length),
      // Not at the top, where a label at the top of the range overflows by less than the margin:
      // a margin that comes and goes with the range draws the whole chart twice. The types for
      // Plotly 3 allow only a boolean.
      automargin: 'left' as unknown as boolean,
      zeroline: false,
      uirevision: `${revision}\0${metric ?? ''}`,
      ...(title === null ? {} : { title: { text: escapeHtml(title) } }),
    }
    // The axis of the panel's regressions' markers, which spans the panel whatever its zoom, and
    // is not shown.
    axes[layoutAxis(markers)] = overlayAxis(values)
  })
  return {
    margin: { t: 10, r: 20, b: 120, l: 70 },
    xaxis: {
      type: 'category',
      categoryorder: 'array',
      categoryarray: commits,
      // An object mapping each label to the text shown in its place, which the types for Plotly 3
      // mistake for a tick value (see plotly-basic.d.ts).
      labelalias: Object.fromEntries(
        commits.map((commit) => [commit, escapeHtml(displayValue(commit))]),
      ) as unknown as DTickValue,
      ...(commits.length > 0 ? { range: [-0.5, commits.length - 0.5], autorange: false } : {}),
      tickangle: -45,
      automargin: true,
      // Under the bottom panel, at the bottom of the plot, rather than anchored to the bottom panel's
      // y-axis. Plotly gives the axis a bar to drag it by under its main subplot, the one of the
      // axis it is anchored to, but leaves behind the bar it gave a previous main subplot: a chart
      // drawn with one panel, then with two, would keep an invisible bar to drag the x-axis by over
      // the top panel. Free, its main subplot stays the top panel's however many panels there are.
      anchor: 'free',
      position: 0,
    },
    ...axes,
    // The axis of the baselines' lines, which span the plot whatever its zoom, and is not shown.
    xaxis2: overlayAxis('x'),
    shapes,
    showlegend: false,
    hovermode: 'closest',
    hoverdistance: 8,
    uirevision: revision,
    annotations: panels.flatMap(({ empty }, i) => {
      const [bottom, top] = panelDomain(i, panels.length)
      return noDataAnnotations(empty, (bottom + top) / 2)
    }),
  }
}

/**
 * What a double-click on a chart of `count` panels resets, besides the axes of the panel
 * double-clicked, which Plotly resets itself: the y-axis of every panel, as a relayout (GR5).
 */
export function panelsReset(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${layoutAxis(panelAxes(i).values)}.autorange`, true]),
  )
}

/**
 * The title of the y-axis of a metric's panel (GR1): its label, followed by its short unit in
 * parentheses (see `shortUnit`).
 */
export function panelTitle(metric: Metric): string {
  const unit = shortUnit(metric)
  return unit === null ? labelOf(metric) : `${labelOf(metric)} (${unit})`
}
