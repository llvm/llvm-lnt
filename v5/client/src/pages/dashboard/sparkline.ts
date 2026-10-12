/**
 * What a Dashboard card draws (DA2), computed from the trend the API returns, apart from the chart
 * that draws it.
 */

import type { Data } from 'plotly.js'
import type { TrendPoint } from '../../api/trends'
import { traceColor } from '../../chart-colors'
import { escapeHtml, formatNumber } from '../../format'
import type { Metric } from '../../schema'

/** How many machines a suite's cards show (DA2). */
export const MACHINES_SHOWN = 5

/** The colour of the `index`th machine of a suite's cards, the same on every card. */
export function machineColor(index: number): string {
  return traceColor(index)
}

/** One machine's line on a card. */
export interface SparklineTrace {
  machine: string
  color: string
  /** Each point's position among the commits the card has data at, in ordinal order. */
  x: number[]
  /** The trend items behind the points, in the same order. */
  points: TrendPoint[]
}

/**
 * One trace per machine of `machines` that has data in `items`, in the order of `machines`, whose
 * position gives its colour, so that a machine has the same colour on every card of a suite. The
 * x-axis is sequential (DA2): commits are evenly spaced, whatever the gaps between their ordinals,
 * and only the commits some trace has data at have a position.
 */
export function sparklineTraces(items: TrendPoint[], machines: string[]): SparklineTrace[] {
  const sorted = items.toSorted((a, b) => a.ordinal - b.ordinal)
  const ordinals = [...new Set(sorted.map((item) => item.ordinal))]
  const position = new Map(ordinals.map((ordinal, index) => [ordinal, index]))
  return machines.flatMap((machine, index) => {
    const points = sorted.filter((item) => item.machine === machine)
    if (points.length === 0) return []
    return [
      {
        machine,
        color: machineColor(index),
        x: points.map((point) => position.get(point.ordinal)!),
        points,
      },
    ]
  })
}

/**
 * A trend value, with the metric's unit abbreviation, or its unit when it has none (DA2). It is a
 * real even for an `integer` metric (E9), so it is shown as one (AR6).
 */
export function formatTrendValue(value: number, metric: Metric): string {
  const unit = metric.unit_abbrev ?? metric.unit
  return unit === null ? formatNumber(value) : `${formatNumber(value)} ${unit}`
}

/**
 * The traces handed to Plotly: a line per machine, each point labelled with the machine, the
 * commit's display value and the value (DA2). A machine with a single point is drawn as a marker,
 * which a line of one point would not show. A machine's line runs straight across the commits
 * where it has no value, since its trace only holds the commits where it has one.
 */
export function plotlyTraces(
  traces: SparklineTrace[],
  displayValue: (point: TrendPoint) => string,
  metric: Metric,
): Data[] {
  return traces.map((trace) => {
    const machine = `<b>${escapeHtml(trace.machine)}</b>`
    const label = (point: TrendPoint) =>
      [
        machine,
        escapeHtml(displayValue(point)),
        escapeHtml(formatTrendValue(point.value, metric)),
      ].join('<br>')
    return {
      type: 'scatter',
      mode: trace.x.length === 1 ? 'markers' : 'lines',
      name: escapeHtml(trace.machine),
      x: trace.x,
      y: trace.points.map((point) => point.value),
      line: { color: trace.color, width: 1.5 },
      marker: { color: trace.color, size: 5 },
      text: trace.points.map(label),
      hovertemplate: '%{text}<extra></extra>',
    }
  })
}

/** What a card's chart shows, in words, for assistive technology: each machine's latest value. */
export function sparklineDescription(
  traces: SparklineTrace[],
  displayValue: (point: TrendPoint) => string,
  metric: Metric,
): string {
  const latest = traces.map((trace) => {
    const point = trace.points[trace.points.length - 1]
    return `${trace.machine}, ${formatTrendValue(point.value, metric)} at ${displayValue(point)}`
  })
  return `Latest values: ${latest.join('; ')}.`
}
