/**
 * What the Compare page's chart draws (CP3): a bar per compared test, sorted by ratio, on a log2
 * axis labelled with percentage changes, the noise band, and the shadow's line (CP8), computed
 * apart from the chart.
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

/** The share of each bar's slot left empty between it and the next. */
export const BAR_GAP = 0.1

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

/** The colours of the shadows' lines (CP8): distinct from those of the statuses. */
export const SHADOW_COLORS = [
  '#7c3aed',
  '#0284c7',
  '#d97706',
  '#db2777',
  '#0d9488',
] as const

/** The colour of the first shadow's line (CP8). */
export const SHADOW_COLOR = SHADOW_COLORS[0]

/** At most how many shadows can be pinned at once (CP8). */
export const MAX_SHADOWS = 5

/**
 * Where `bars` are drawn, at positions 0 to N - 1, and their tooltip, giving the test, followed by
 * `label` if any, the exact ratio, both sides' values and Delta % (CP3). Test names are escaped:
 * Plotly reads them as HTML.
 */
function plotted(bars: readonly Bar[], label = ''): Partial<PlotData> {
  return {
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
      `<b>%{customdata[0]}</b>${label}<br>Ratio: %{customdata[1]}<br>A: %{customdata[2]}<br>` +
      'B: %{customdata[3]}<br>Delta %: %{customdata[4]}<extra></extra>',
  }
}

/** The bars, as one Plotly trace, coloured by status (CP3). */
export function barTrace(bars: readonly Bar[]): Partial<PlotData> {
  return {
    type: 'bar',
    name: 'comparison',
    ...plotted(bars),
    marker: { color: bars.map((bar) => STATUS_COLORS[bar.status]) },
  }
}

/** A shadow comparison, as a thin line through its points, sorted by their own ratios (CP8). */
export function shadowTrace(
  points: readonly Bar[],
  color: string = SHADOW_COLOR,
): Partial<PlotData> {
  return {
    type: 'scatter',
    mode: 'lines+markers',
    name: 'shadow',
    ...plotted(points, ' (shadow)'),
    line: { color, width: 1.5 },
    marker: { color, size: 4 },
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
 * The range the chart spans when not zoomed: its bars, from 0, the shadows' points, if any, and the
 * noise band, if any, which the ticks are computed over.
 */
export function chartExtent(
  bars: readonly Bar[],
  band: { upper: number; lower: number } | null,
  shadows: readonly Bar[] | readonly (readonly Bar[])[] = [],
): [number, number] {
  let min = Math.min(0, band?.lower ?? 0)
  let max = Math.max(0, band?.upper ?? 0)
  const shadowLists =
    shadows.length > 0 && Array.isArray(shadows[0])
      ? (shadows as readonly (readonly Bar[])[])
      : [shadows as readonly Bar[]]
  for (const list of [bars, ...shadowLists]) {
    for (const { y } of list) {
      if (y < min) min = y
      if (y > max) max = y
    }
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
export function compareLayout({ ticks, band, revision, empty }: LayoutOptions): Partial<Layout> {
  return {
    margin: { t: 10, r: 20, b: 40, l: 70 },
    xaxis: { showticklabels: false, zeroline: false, title: { text: 'Tests, by ratio' } },
    yaxis: { ...ticks, tickmode: 'array', zeroline: true, automargin: true },
    bargap: BAR_GAP,
    shapes: band === null ? [] : [bandLine(band.upper), bandLine(band.lower)],
    showlegend: false,
    hovermode: 'closest',
    uirevision: revision,
    annotations: noDataAnnotations(empty),
  }
}
