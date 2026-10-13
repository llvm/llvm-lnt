/**
 * What the Compare page's chart draws (CP3): a bar per compared test, sorted by ratio, on a log2
 * axis labelled with percentage changes, and the noise band, computed apart from the chart.
 */

import type { Layout, PlotData, Shape } from 'plotly.js'
import { noDataAnnotations } from '../../components/plot-annotations'
import { compareStrings, escapeHtml, formatNumber } from '../../format'
import { formatDeltaPct, formatRatio } from './columns'
import type { ComparisonRow, Status } from './comparison'

/** A compared test the chart can plot: one whose ratio is defined and positive (CP2). */
export interface Bar {
  test: string
  /** Where the bar reaches on the chart's axis: the log2 of its ratio. */
  y: number
  status: Status
  a: number
  b: number
  ratio: number
  deltaPct: number
}

/**
 * The bars of `rows`, the compared rows, sorted by ratio, ascending, ties by test name. A row is
 * left out when only one side has a value, with a zero baseline, or when its ratio is not positive,
 * which log2 is undefined for (CP2 "Chart Y-axis").
 */
export function chartBars(rows: readonly ComparisonRow[]): Bar[] {
  const bars: Bar[] = []
  for (const { test, status, a, b, ratio, deltaPct } of rows) {
    if (a === null || b === null || ratio === null || deltaPct === null || ratio <= 0) continue
    bars.push({ test, y: Math.log2(ratio), status, a, b, ratio, deltaPct })
  }
  return bars.sort((x, y) => x.ratio - y.ratio || compareStrings(x.test, y.test))
}

/**
 * The colours of the bars, by status (CP2): those of the table, `--lnt-success` and `--lnt-danger`
 * (see index.css), and grey otherwise. Plotly needs them as values rather than CSS variables.
 */
const STATUS_COLORS: Record<Status, string> = {
  improved: '#15803d',
  regressed: '#b91c1c',
  noise: '#9ca3af',
  unchanged: '#9ca3af',
  na: '#9ca3af',
}

/**
 * The bars, as one Plotly trace, at positions 0 to N - 1, with a tooltip giving the test, the exact
 * ratio, both sides' values and Delta % (CP3). Test names are escaped, as Plotly reads them as HTML.
 */
export function barTrace(bars: readonly Bar[]): Partial<PlotData> {
  return {
    type: 'bar',
    name: 'comparison',
    x: bars.map((_, i) => i),
    y: bars.map((bar) => bar.y),
    customdata: bars.map((bar) => [
      escapeHtml(bar.test),
      formatRatio(bar.ratio),
      formatNumber(bar.a),
      formatNumber(bar.b),
      formatDeltaPct(bar.deltaPct),
    ]) as unknown as PlotData['customdata'],
    hovertemplate:
      '<b>%{customdata[0]}</b><br>Ratio: %{customdata[1]}<br>A: %{customdata[2]}<br>' +
      'B: %{customdata[3]}<br>Delta %: %{customdata[4]}<extra></extra>',
    marker: { color: bars.map((bar) => STATUS_COLORS[bar.status]) },
  }
}

/**
 * The outline of `bar`, the `index`th, as the test hovered in the table (CP5): a shape over the
 * plot rather than a style of the bars, so that Plotly need not compute them again.
 */
export function emphasisShape(bar: Bar, index: number): Partial<Shape> {
  return {
    type: 'rect',
    xref: 'x',
    yref: 'y',
    x0: index - 0.5,
    x1: index + 0.5,
    y0: 0,
    y1: bar.y,
    layer: 'above',
    line: { color: '#111827', width: 2 },
  }
}

/**
 * The noise band (CP2 "Noise band on chart"): the log2 ratios of the Delta % threshold `pct`, above
 * and below, made symmetric from 100% on, where the one below is undefined.
 */
export function noiseBand(pct: number): { upper: number; lower: number } {
  const upper = Math.log2(1 + pct / 100)
  return { upper, lower: pct < 100 ? Math.log2(1 - pct / 100) : -upper }
}

/** The percentage changes the y-axis may label, as positive values: those of gains, of losses. */
const GAINS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 50000]
const LOSSES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 75, 90, 95, 99]

/** Each candidate tick: its position on the log2 axis, and its label. */
const CANDIDATES = [
  { at: 0, label: '0%' },
  ...GAINS.map((pct) => ({ at: Math.log2(1 + pct / 100), label: `+${pct}%` })),
  ...LOSSES.map((pct) => ({ at: Math.log2(1 - pct / 100), label: `-${pct}%` })),
].sort((x, y) => x.at - y.at)

/** At most how many ticks the y-axis has. */
const MAX_TICKS = 10

/**
 * The ticks of the y-axis over `[min, max]` (CP3): the "nice" percentage changes within it, at
 * their log2 positions, kept apart by at least a tenth of the range so that their labels do not
 * overlap, 0% winning over a neighbour too close to it. A narrow range gets fine ticks (+/-1%,
 * +/-2%), a wide one coarse ones (+/-50%, +/-100%).
 */
export function ratioTicks(min: number, max: number): { tickvals: number[]; ticktext: string[] } {
  const span = max - min || 0.01
  const pad = span * 0.05
  const gap = span / MAX_TICKS
  const kept: (typeof CANDIDATES)[number][] = []
  for (const candidate of CANDIDATES) {
    if (candidate.at < min - pad || candidate.at > max + pad) continue
    const last = kept.at(-1)
    if (last === undefined || candidate.at - last.at >= gap) kept.push(candidate)
    else if (candidate.at === 0) kept[kept.length - 1] = candidate
  }
  if (kept.length === 0) kept.push(CANDIDATES.find((candidate) => candidate.at === 0)!)
  return { tickvals: kept.map((tick) => tick.at), ticktext: kept.map((tick) => tick.label) }
}

/**
 * The range the chart spans when not zoomed: its bars, from 0, and the noise band, if any, which
 * the ticks are computed over.
 */
export function chartExtent(
  bars: readonly Bar[],
  band: { upper: number; lower: number } | null,
): [number, number] {
  let min = Math.min(0, band?.lower ?? 0)
  let max = Math.max(0, band?.upper ?? 0)
  for (const { y } of bars) {
    if (y < min) min = y
    if (y > max) max = y
  }
  return [min, max]
}

interface LayoutOptions {
  ticks: { tickvals: number[]; ticktext: string[] }
  band: { upper: number; lower: number } | null
  /** What the comparison is: a new value resets what the user did to the chart (CP3 "Zoom"). */
  revision: string
  /** Whether to say that there is nothing to plot (CP3 "Empty state"). */
  empty: boolean
  /** The outline of the bar hovered in the table, if any. */
  emphasis?: Partial<Shape>
}

/** A dashed line across the plot at `y`, for the noise band. */
function bandLine(y: number): Partial<Shape> {
  return {
    type: 'line',
    xref: 'paper',
    yref: 'y',
    x0: 0,
    x1: 1,
    y0: y,
    y1: y,
    layer: 'below',
    line: { color: '#6b7280', width: 1, dash: 'dash' },
  }
}

/**
 * The chart's layout: no labels on the x-axis, whose bars are tests, and the y-axis labelled with
 * percentage changes at the positions of `ticks`. A zoom is kept until `revision` changes, and the
 * y-axis otherwise fits what is plotted (CP3).
 */
export function compareLayout({
  ticks,
  band,
  revision,
  empty,
  emphasis,
}: LayoutOptions): Partial<Layout> {
  return {
    margin: { t: 10, r: 20, b: 40, l: 70 },
    xaxis: { showticklabels: false, zeroline: false, title: { text: 'Tests, by ratio' } },
    yaxis: { ...ticks, tickmode: 'array', zeroline: true, automargin: true },
    bargap: 0.1,
    shapes: [
      ...(band === null ? [] : [bandLine(band.upper), bandLine(band.lower)]),
      ...(emphasis === undefined ? [] : [emphasis]),
    ],
    showlegend: false,
    hovermode: 'closest',
    uirevision: revision,
    annotations: noDataAnnotations(empty),
  }
}
