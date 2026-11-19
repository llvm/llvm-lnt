/**
 * What the Compare page's chart draws (CP3): a bar per compared test, sorted by ratio, on a log2
 * axis labelled with percentage changes, and the shadows' lines (CP8), computed apart from the
 * chart.
 */

import type { Layout, PlotData } from 'plotly.js'
import { markerOf } from '../../chart-markers'
import { noDataAnnotations } from '../../components/plot-annotations'
import { compareStrings, escapeHtml, formatNumber } from '../../format'
import { formatDeltaPct, formatRatio, intervalIs, noIntervalReason } from './columns'
import { LABELS, type ComparisonRow, type Status, type Values } from './comparison'

/** A test to plot: a compared row of the main comparison, or of a shadow's (CP8). */
export type Plottable = Pick<Values, 'a' | 'b' | 'ratio' | 'deltaPct'> & { test: string }

/**
 * A compared row the chart can plot: one whose ratio is defined and positive (CP2), with where its
 * bar reaches on the chart's axis, `y`: the log2 of its ratio.
 */
export type Bar<R extends Plottable = Plottable> = R & {
  y: number
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
export function chartBars<R extends Plottable>(rows: readonly R[]): Bar<R>[] {
  const bars: Bar<R>[] = []
  for (const row of rows) {
    const { a, b, ratio, deltaPct } = row
    if (a === null || b === null || ratio === null || deltaPct === null || ratio <= 0) continue
    bars.push({ ...row, y: Math.log2(ratio), a, b, ratio, deltaPct })
  }
  return bars.sort((x, y) => x.ratio - y.ratio || compareStrings(x.test, y.test))
}

/** The share of each bar's slot left empty between it and the next. */
export const BAR_GAP = 0.1

/**
 * The colours of the bars, by status (CP2): those of the table, `--lnt-success`, `--lnt-danger`
 * and `--lnt-warning` (see index.css), and grey otherwise. Plotly needs them as values rather than
 * CSS variables.
 */
const STATUS_COLORS: Record<Status, string> = {
  improved: '#15803d',
  regressed: '#b91c1c',
  unchanged: '#9ca3af',
  inconclusive: '#d97706',
  na: '#9ca3af',
}

/**
 * The colours of the shadows' lines (CP8), by their position among the shadows: apart from those
 * of the statuses, from the outline of a bar (CP5) and from each other, each with a contrast of at
 * least 3:1 against the page's background. Each shadow also has a marker of its own, since
 * colours alone cannot keep five lines apart for every reader.
 */
export const SHADOW_COLORS = ['#7c3aed', '#552200', '#0369a1', '#86198f', '#312e81'] as const

/** The colour and the marker of the `index`th shadow. */
export function shadowLook(index: number) {
  return { color: SHADOW_COLORS[index % SHADOW_COLORS.length], marker: markerOf(index) }
}

/** A main bar's status, with its confidence interval or why it has none, as a line of a tooltip. */
function statusLine({ status, change }: ComparisonRow): string {
  const why = change.kind === 'interval' ? intervalIs(change) : noIntervalReason(change)
  return escapeHtml(`Status: ${LABELS[status]}, ${why}`)
}

/**
 * Where `bars` are drawn, at positions 0 to N - 1, and their tooltip, giving the test, followed by
 * a line holding `label` if any, the exact ratio, both sides' values and Delta % (CP3), then the
 * lines `after` gives, if any, as HTML. The test, the label and those lines are passed as data
 * rather than written into the template: Plotly reads them as HTML, and the template would read
 * `%{` in them as its own.
 */
function plotted<R extends Plottable>(
  bars: readonly Bar<R>[],
  { label, after }: { label?: string; after?: (bar: Bar<R>) => string },
): Partial<PlotData> {
  const before = label === undefined ? '' : `<br>${escapeHtml(label)}`
  return {
    x: bars.map((_, i) => i),
    y: bars.map((bar) => bar.y),
    customdata: bars.map((bar) => [
      escapeHtml(bar.test),
      formatRatio(bar.ratio),
      formatNumber(bar.a),
      formatNumber(bar.b),
      formatDeltaPct(bar.deltaPct),
      before,
      after === undefined ? '' : `<br>${after(bar)}`,
    ]) as unknown as PlotData['customdata'],
    hovertemplate:
      '<b>%{customdata[0]}</b>%{customdata[5]}<br>Ratio: %{customdata[1]}<br>' +
      'A: %{customdata[2]}<br>B: %{customdata[3]}<br>Delta %: %{customdata[4]}' +
      '%{customdata[6]}<extra></extra>',
  }
}

/**
 * The bars, as one Plotly trace, coloured by status, whose tooltips give the status, with its
 * confidence interval or why it has none, and a last line saying that clicking a bar shows its
 * details (CP3).
 */
export function barTrace(bars: readonly Bar<ComparisonRow>[]): Partial<PlotData> {
  return {
    type: 'bar',
    name: 'comparison',
    ...plotted(bars, { after: (bar) => `${statusLine(bar)}<br><i>Click for details</i>` }),
    marker: { color: bars.map((bar) => STATUS_COLORS[bar.status]) },
  }
}

/**
 * The comparison of the `index`th shadow, which `label` names on a line of the tooltips after the
 * test's, as a thin line through its points, sorted by their own ratios, in its colour and with
 * its marker (CP8).
 */
export function shadowTrace(
  points: readonly Bar[],
  index: number,
  label: string,
): Partial<PlotData> {
  const { color, marker } = shadowLook(index)
  return {
    type: 'scatter',
    mode: 'lines+markers',
    name: `shadow ${index + 1}`,
    // A point of a line has no details, nor a status (CP8).
    ...plotted(points, { label }),
    line: { color, width: 1.5 },
    marker: { color, size: 6, symbol: marker.symbol },
  }
}

/** The percentage changes the y-axis labels at any range, as positive values: gains, losses. */
const GAINS = [-1, 0, 1, 2, 3, 4, 5].flatMap((power) => [1, 2, 5].map((m) => m * 10 ** power))
const LOSSES = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 75, 90, 95, 99, 99.9, 99.99, 99.999]

/** At most how many ticks the y-axis has. */
const MAX_TICKS = 10

/** The percentage change of a position on the log2 axis, and the position of a change. */
const pctOf = (at: number) => (2 ** at - 1) * 100
const atOf = (pct: number) => Math.log2(1 + pct / 100)

/** `value`, without the rounding errors of the arithmetic that gave it. */
const tidy = (value: number) => Number(value.toPrecision(12))

/** A tick's label: the percentage change, signed, as `+5%`, `-0.5%`, `0%`. */
function labelOf(pct: number): string {
  if (pct === 0) return '0%'
  return `${pct > 0 ? '+' : '-'}${Number(Math.abs(pct).toPrecision(6))}%`
}

/** A "nice" step for about `count` ticks over `span`: 1, 2 or 5 times a power of 10. */
function niceStep(span: number, count: number): number {
  const rough = span / count
  const power = 10 ** Math.floor(Math.log10(rough))
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= rough) ?? 10 * power
}

/**
 * The ticks of the y-axis over `[min, max]` (CP3): "nice" percentage changes at their log2
 * positions, adapted to the range shown. They are drawn from the changes labelled at any range
 * (+/-1%, +/-5%, +/-50%, +100%...) and from evenly spaced ones across the range, so that a range
 * away from 0% is labelled too. They are kept apart by at least a tenth of the range, so that their
 * labels do not overlap, 0% winning over a neighbour too close to it.
 */
export function ratioTicks(min: number, max: number): { tickvals: number[]; ticktext: string[] } {
  const span = max - min || 0.01
  const pad = span * 0.02
  const gap = span / MAX_TICKS
  const [low, high] = [pctOf(min), pctOf(max)]
  const step = niceStep(Math.max(high - low, 1e-6), 5)
  const even: number[] = []
  for (let k = Math.ceil(low / step); k * step <= high; k++) {
    if (k * step > -100) even.push(tidy(k * step))
  }
  const pcts = new Set([0, ...GAINS, ...LOSSES.map((pct) => -pct), ...even])
  const candidates = [...pcts]
    .map((pct) => ({ at: atOf(pct), pct }))
    .filter(({ at }) => at >= min - pad && at <= max + pad)
    .sort((x, y) => x.at - y.at)
  const kept: typeof candidates = []
  for (const candidate of candidates) {
    const last = kept.at(-1)
    if (last === undefined || candidate.at - last.at >= gap) kept.push(candidate)
    else if (candidate.pct === 0) kept[kept.length - 1] = candidate
  }
  // Only a range too narrow for any change to fall in has none: its ends are labelled then.
  if (kept.length === 0) kept.push({ at: min, pct: low }, { at: max, pct: high })
  return { tickvals: kept.map((tick) => tick.at), ticktext: kept.map((tick) => labelOf(tick.pct)) }
}

/**
 * The range the chart spans when not zoomed: its bars, from 0, and the shadows' points, if any,
 * which the ticks are computed over.
 */
export function chartExtent(
  bars: readonly Bar[],
  shadows: readonly (readonly Bar[])[] = [],
): [number, number] {
  let min = 0
  let max = 0
  for (const list of [bars, ...shadows]) {
    for (const { y } of list) {
      if (y < min) min = y
      if (y > max) max = y
    }
  }
  return [min, max]
}

interface LayoutOptions {
  ticks: { tickvals: number[]; ticktext: string[] }
  /** What the comparison is: a new value resets what the user did to the chart (CP3 "Zoom"). */
  revision: string
  /** Whether to say that there is nothing to plot (CP3 "Empty state"). */
  empty: boolean
}

/**
 * The chart's layout: no labels on the x-axis, whose bars are tests, and the y-axis labelled with
 * percentage changes at the positions of `ticks`. A zoom is kept until `revision` changes, and the
 * y-axis otherwise fits what is plotted (CP3).
 */
export function compareLayout({ ticks, revision, empty }: LayoutOptions): Partial<Layout> {
  return {
    margin: { t: 10, r: 20, b: 40, l: 70 },
    xaxis: { showticklabels: false, zeroline: false, title: { text: 'Tests, by ratio' } },
    yaxis: { ...ticks, tickmode: 'array', zeroline: true, automargin: true },
    bargap: BAR_GAP,
    showlegend: false,
    hovermode: 'closest',
    uirevision: revision,
    annotations: noDataAnnotations(empty),
  }
}
