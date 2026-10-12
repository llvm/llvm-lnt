/**
 * What the Graph page's chart draws (GR1, GR3, GR5, GR10, GR12), computed apart from the chart
 * that draws it.
 */

import type { Data, DTickValue, Layout } from 'plotly.js'
import { escapeHtml, plural } from '../../format'
import { formatMetricValue, type Metric } from '../../schema'
import type { Point } from './points'

/**
 * The marker of each machine, by its position among the machines' chips (GR1): Plotly's symbol,
 * and the character showing it on the machine's chip. Once all are taken, they start over.
 */
const MARKERS = [
  { symbol: 'circle', char: '●' },
  { symbol: 'triangle-up', char: '▲' },
  { symbol: 'square', char: '■' },
  { symbol: 'diamond', char: '◆' },
  { symbol: 'cross', char: '✚' },
  { symbol: 'x', char: '✖' },
  { symbol: 'star', char: '★' },
  { symbol: 'pentagon', char: '⬟' },
] as const

export function markerOf(index: number): (typeof MARKERS)[number] {
  return MARKERS[index % MARKERS.length]
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
 * commit, with a tooltip naming the test, the machine and the commit, and giving the value and how
 * many runs it combines (GR10). Text from the API is escaped, as Plotly reads it as HTML.
 */
export function plotlyTraces(traces: Trace[], displayValue: DisplayValue, metric: Metric): Data[] {
  return traces.map(({ test, machine, machineIndex, color, points }) => {
    const name = `${escapeHtml(test)} - ${escapeHtml(machine)}`
    return {
      type: 'scatter',
      mode: 'lines+markers',
      name,
      x: points.map((point) => point.commit),
      y: points.map((point) => point.value),
      customdata: points.map((point) => [
        escapeHtml(displayValue(point.commit)),
        formatMetricValue(point.value, metric),
        plural(point.runs, 'run'),
      ]),
      hovertemplate:
        `<b>${escapeHtml(test)}</b><br>Machine: ${escapeHtml(machine)}<br>` +
        'Commit: %{customdata[0]}<br>Value: %{customdata[1]}<br>%{customdata[2]}<extra></extra>',
      line: { color, width: 1.5 },
      marker: { color, size: 6, symbol: markerOf(machineIndex).symbol },
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
    showlegend: false,
    hovermode: 'closest',
    hoverdistance: 8,
    uirevision: revision,
    annotations: empty
      ? [
          {
            text: 'No data to plot',
            showarrow: false,
            xref: 'paper',
            yref: 'paper',
            x: 0.5,
            y: 0.5,
            font: { size: 16, color: '#6b7280' },
          },
        ]
      : [],
  }
}
