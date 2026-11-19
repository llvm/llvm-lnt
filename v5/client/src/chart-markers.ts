/**
 * The marker shapes the charts tell their traces apart by, beside their colours: the Graph page's
 * machines (GR1), the Compare page's shadows (CP8). And when their points have markers: only while
 * few enough positions of the x-axis are in view.
 */

import { useState } from 'react'
import type { PlotGeometry } from './components/chart'

/** Each marker: Plotly's symbol, and the character showing it on a chip. */
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

/** The marker of the `index`th trace, starting over once every marker is taken. */
export function markerOf(index: number): (typeof MARKERS)[number] {
  return MARKERS[index % MARKERS.length]
}

/**
 * At most how many positions of the x-axis -- the Graph's commits (GR1), Compare's tests (CP8) --
 * can be in view for the traces' points to have markers. Beyond, the markers are too close
 * together to tell apart, and drawing one per point is what makes a large chart slow to draw.
 */
export const MARKED_POSITIONS = 200

/**
 * The `maxdisplayed` of a trace's markers. With it, Plotly draws only the markers of the points in
 * view (x and y in range), rather than every point's, and only that many of them, evenly spaced,
 * when more are in view. That leaves room for the marker of every point in view while the points
 * have markers, but for a draw counted on the axis drawn before (see `useMarkers`), which it keeps
 * cheap.
 */
export const MAX_DISPLAYED_MARKERS = 2 * MARKED_POSITIONS

/**
 * How many pixels beyond an edge of the plot a position still counts as in view (see
 * `positionsInView`). An x-axis fitting a line without markers ends at its last point, which
 * Plotly's rounding may put a fraction of a pixel beyond the edge. Counted out of view, it would
 * give the points markers, which Plotly pads the axis for, bringing it back into view, and so on.
 */
const EDGE_SLACK = 0.5

/**
 * How many of the `count` positions of the x-axis are in view in a plot drawn as `geometry` says:
 * the positions from 0 to `count - 1` between the left and right edges of the plot, give or take
 * EDGE_SLACK. Plotly rounds the pixels of a position, so the step between two is taken across the
 * whole axis, lest its error add up far from position 0.
 */
export function positionsInView({ area, x }: PlotGeometry, count: number): number {
  const span = Math.max(count - 1, 1)
  const step = (x(span) - x(0)) / span
  const [left, right] = [area.left - EDGE_SLACK, area.left + area.width + EDGE_SLACK]
  const first = Math.max(0, Math.ceil((left - x(0)) / step))
  const last = Math.min(count - 1, Math.floor((right - x(0)) / step))
  return Math.max(0, last - first + 1)
}

/**
 * How a trace of `points` points is drawn: a line with a marker at each point, or the line alone
 * when the points have no `markers` (see `MARKED_POSITIONS`). A single point keeps its marker,
 * without which it would draw nothing.
 */
export function traceMode(points: number, markers: boolean): 'lines' | 'lines+markers' {
  return markers || points === 1 ? 'lines+markers' : 'lines'
}

/**
 * Where a chart of `count` positions on its x-axis last drew, as its `onDraw` reports, and whether
 * its points have markers: while at most MARKED_POSITIONS are in view, all of them counting as in
 * view until the chart has drawn for `revision`, a change of which resets its zoom. Drawing the
 * markers or not asks for no other draw: zoomed in, the axis stays as the user left it, and not
 * zoomed, every position is in view, however Plotly pads the axis for the markers.
 *
 * A new `count` alone does not forget the draw: zoomed in, it moves nothing, and the chart reports
 * no draw that moves nothing (see chart.tsx), so that the count would wait for the next zoom. Not
 * zoomed, it is counted on the axis drawn before until the chart draws again: a `count` growing
 * past MARKED_POSITIONS is drawn once with markers, then again without.
 */
export function useMarkers(count: number, revision: string) {
  const [drawnAt, setDrawnAt] = useState<{ geometry: PlotGeometry; revision: string } | null>(
    null,
  )
  const inView = drawnAt?.revision === revision ? positionsInView(drawnAt.geometry, count) : count
  return {
    geometry: drawnAt?.geometry ?? null,
    markers: inView <= MARKED_POSITIONS,
    onDraw: (geometry: PlotGeometry) => setDrawnAt({ geometry, revision }),
  }
}
