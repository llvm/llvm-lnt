/**
 * What the Graph page's chart draws (GR1, GR3, GR5, GR7, GR9, GR10, GR12, GR15), computed apart
 * from the chart that draws it.
 */

import type { Data, DTickValue, Layout, LayoutAxis, PlotData, Shape } from 'plotly.js'
import { markerOf } from '../../chart-markers'
import { noDataAnnotations } from '../../components/plot-annotations'
import { escapeHtml, plural, regressionTitle } from '../../format'
import type { RegressionState } from '../../regression-states'
import { formatMetricValue, type Metric } from '../../schema'
import type { Point } from './points'

/** An axis over `axis` spanning the plot from 0 to 1 whatever its zoom, which is not shown. */
function overlayAxis(axis: 'x' | 'y'): Partial<LayoutAxis> {
  return { overlaying: axis, range: [0, 1], fixedrange: true, visible: false }
}

/** One test on one machine, as the chart draws it. */
export interface Trace {
  test: string
  machine: string
  /** The machine's position among the chips, which gives its marker. */
  machineIndex: number
  color: string
  points: Point[]
}

/** The text a chart shows of a commit: its display value (AR6). */
export type DisplayValue = (commit: string) => string

/**
 * The traces as Plotly draws them: lines with a marker at each point, placed on the x-axis by
 * commit, with a tooltip naming the test, the machine and the commit, giving the value and how many
 * runs it combines, and saying that a click shows the point's details (GR10). Text from the API is
 * escaped and passed as data rather than written into the template (see chart.tsx).
 */
export function plotlyTraces(traces: Trace[], displayValue: DisplayValue, metric: Metric): Data[] {
  return traces.map(({ test, machine, machineIndex, color, points }) => {
    const escapedTest = escapeHtml(test)
    const escapedMachine = escapeHtml(machine)
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name: `${escapedTest} - ${escapedMachine}`,
      x: points.map((point) => point.commit),
      y: points.map((point) => point.value),
      customdata: points.map((point) => [
        escapeHtml(displayValue(point.commit)),
        formatMetricValue(point.value, metric),
        plural(point.runs, 'run'),
        escapedTest,
        escapedMachine,
      ]),
      hovertemplate:
        '<b>%{customdata[3]}</b><br>Machine: %{customdata[4]}<br>' +
        'Commit: %{customdata[0]}<br>Value: %{customdata[1]}<br>%{customdata[2]}<br>' +
        '<i>Click for details</i><extra></extra>',
      line: { color, width: 1.5 },
      marker: { color, size: 6, symbol: markerOf(machineIndex).symbol },
    }
  })
}

/**
 * `trace`, emphasized as the test hovered in the test table (GR7) when `emphasized`, and faded
 * otherwise, sharing its points with `trace` so that Plotly need not compute them again.
 */
export function withEmphasis(trace: Partial<PlotData>, emphasized: boolean): Partial<PlotData> {
  return emphasized ? { ...trace, line: { ...trace.line, width: 3 } } : { ...trace, opacity: 0.2 }
}

/** A baseline's line for one test (GR9). */
export interface BaselineLine {
  suite: string
  machine: string
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
 * The baselines' lines (GR9): one dashed line per baseline and test, across the whole width of the
 * chart at any zoom, on an x-axis of their own spanning 0 to 1. Their points are along that axis,
 * however many commits the chart has, so that the line can be hovered from anywhere along it.
 */
export function baselineTraces(lines: BaselineLine[], metric: Metric): Data[] {
  return lines.map(({ suite, machine, commit, test, value, color }) => {
    const tooltip = [suite, machine, commit, test, formatMetricValue(value, metric)].map(escapeHtml)
    return {
      type: 'scatter',
      mode: 'lines',
      name: `${escapeHtml(test)} - baseline ${escapeHtml(`${suite}/${machine}/${commit}`)}`,
      xaxis: 'x2',
      x: SPAN,
      y: SPAN.map(() => value),
      customdata: SPAN.map(() => tooltip),
      hovertemplate:
        '<b>Baseline</b><br>Suite: %{customdata[0]}<br>Machine: %{customdata[1]}<br>' +
        'Commit: %{customdata[2]}<br>Test: %{customdata[3]}<br>' +
        'Value: %{customdata[4]}<extra></extra>',
      line: { color, width: 1.5, dash: 'dash' },
    }
  })
}

/** A regression placed on the chart (GR15). */
export interface PlacedRegression {
  uuid: string
  title: string | null
  state: RegressionState
  /** The commit it is attributed to, which is on the x-axis. */
  commit: string
  /** Its place among the regressions at its commit, from 0: where its marker is stacked. */
  stack: number
}

/**
 * The height of the marker of the regression `stack`th at its commit, on the axis of the markers,
 * which spans the plot from 0 at the bottom to 1 at the top. The lowest stays inside the plot,
 * however many share a commit.
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
 * The regressions' lines (GR15): a dashed vertical line across the plot at each regression's
 * commit, which is not hovered, so that the points along it can be.
 */
export function regressionShapes(
  marks: Pick<PlacedRegression, 'commit' | 'state'>[],
): Partial<Shape>[] {
  return marks.map(({ commit, state }) => ({
    type: 'line',
    xref: 'x',
    yref: 'paper',
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
 * the regression's details: one per regression, stacked downwards when several share a commit, on
 * a y-axis of their own spanning 0 to 1, so that they neither take part in the scale of the values
 * nor move with a zoom.
 */
export function regressionMarkers(marks: RegressionMark[]): Data[] {
  return marks.map(({ uuid, title, state, commit, tests, stack }) => {
    const named = tests.slice(0, TESTS_NAMED).map(escapeHtml).join('<br>')
    const more = tests.length > TESTS_NAMED ? `<br>and ${tests.length - TESTS_NAMED} more` : ''
    return {
      type: 'scatter',
      mode: 'markers',
      name: `regression ${uuid}`,
      yaxis: 'y2',
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

interface LayoutOptions {
  /** The commit values of the x-axis, in ordinal order (GR3). */
  commits: string[]
  displayValue: DisplayValue
  /**
   * What the x-axis is made of, such as the machines whose scaffold it holds: a new value resets
   * what the user did to the chart (GR5).
   */
  revision: string
  /** The metric plotted, whose change also resets a zoom of the y-axis, on another scale. */
  metric: string | undefined
  /** Whether to say that there is nothing to plot (GR12). */
  empty: boolean
  /** The lines of the regressions shown (GR15). */
  shapes?: Partial<Shape>[]
}

/**
 * The chart's layout. The x-axis is a category per commit of the scaffold, in ordinal order,
 * labelled with each one's display value and spanning all of them whatever the traces cover, so
 * that it neither moves as data arrives (GR3) nor merges two commits that share a display value
 * (GR1). It has no legend of its own: the test table and the machines' chips are one (GR7).
 */
export function graphLayout({
  commits,
  displayValue,
  revision,
  metric,
  empty,
  shapes = [],
}: LayoutOptions): Partial<Layout> {
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
    },
    yaxis: { automargin: true, zeroline: false, uirevision: `${revision}\0${metric ?? ''}` },
    // The axes of the lines drawn across the plot -- the baselines' and the regressions' markers --
    // which span the plot whatever its zoom, and are not shown.
    xaxis2: overlayAxis('x'),
    yaxis2: overlayAxis('y'),
    shapes,
    showlegend: false,
    hovermode: 'closest',
    hoverdistance: 8,
    uirevision: revision,
    annotations: noDataAnnotations(empty),
  }
}
