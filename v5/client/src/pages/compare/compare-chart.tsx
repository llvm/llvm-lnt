import { useMemo, useState } from 'react'
import type { PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { Chart, type PlotGeometry } from '../../components/chart'
import { useStoreValue, type ValueStore } from '../../value-store'
import {
  BAR_GAP,
  barTrace,
  chartBars,
  chartExtent,
  compareLayout,
  noiseBand,
  ratioTicks,
  type Bar,
} from './chart'
import type { ComparisonRow } from './comparison'
import styles from './compare.module.css'

interface Props {
  /** The compared rows (CP2), which the chart plots those of that it can, in any order. */
  rows: ComparisonRow[]
  /** The Delta % knob's threshold, while it is enabled, whose noise band the chart draws. */
  noisePct: number | null
  /** What the comparison is: a change resets the zoom (CP3 "Zoom"). */
  revision: string
  /** The test whose row is hovered in the table, whose bar the chart outlines (CP5). */
  emphasis: ValueStore<string | null>
  /** Where the chart says which test's bar is hovered, for the table to highlight its row. */
  hovered: ValueStore<string | null>
}

/** The y-axis range a relayout zoomed to, null for a reset, undefined for neither. */
function zoomOf(event: PlotRelayoutEvent): [number, number] | null | undefined {
  if (event['yaxis.autorange']) return null
  const low = event['yaxis.range[0]']
  const high = event['yaxis.range[1]']
  return typeof low === 'number' && typeof high === 'number' ? [low, high] : undefined
}

/**
 * The outline of `bar`, the `index`th, over the plot (CP5): drawn apart from the chart, so that
 * outlining another bar, as the pointer moves down the table, does not draw the chart again.
 */
function Outline({ geometry, bar, index }: { geometry: PlotGeometry; bar: Bar; index: number }) {
  const { area } = geometry
  const half = (1 - BAR_GAP) / 2
  const left = geometry.x(index - half) - area.left
  const right = geometry.x(index + half) - area.left
  const [top, bottom] = [geometry.y(bar.y), geometry.y(0)].sort((a, b) => a - b)
  return (
    <svg
      className={styles.overlay}
      style={{ left: area.left, top: area.top, width: area.width, height: area.height }}
      aria-hidden="true"
    >
      <rect
        x={left}
        y={top - area.top}
        width={right - left}
        height={bottom - top}
        fill="none"
        stroke="#111827"
        strokeWidth={2}
      />
    </svg>
  )
}

/**
 * The comparison's chart (CP3): a bar per compared test, by ratio, on a log2 axis labelled with the
 * percentage changes, and the Delta % knob's noise band. Its ticks follow a zoom of the y-axis.
 * Hovering a bar highlights its test's row, and hovering a row outlines its bar (CP5).
 */
export function CompareChart({ rows, noisePct, revision, emphasis, hovered }: Props) {
  const bars = useMemo(() => chartBars(rows), [rows])
  // The trace, and the bars it draws: Plotly reports an event with the trace it drew, which may be
  // one drawn before the latest render, while it is drawing again.
  const drawn = useMemo(() => {
    const trace = barTrace(bars)
    return { data: [trace], barsOf: new WeakMap<object, Bar[]>([[trace, bars]]) }
  }, [bars])

  const band = useMemo(() => (noisePct === null ? null : noiseBand(noisePct)), [noisePct])
  // The y-axis range zoomed to, forgotten once the comparison is replaced, as Plotly forgets it.
  const [zoom, setZoom] = useState<[number, number] | null>(null)
  const [zoomedOn, setZoomedOn] = useState(revision)
  if (zoomedOn !== revision) {
    setZoomedOn(revision)
    setZoom(null)
  }
  const extent = useMemo(() => chartExtent(bars, band), [bars, band])
  const [low, high] = (zoomedOn === revision ? zoom : null) ?? extent
  const empty = bars.length === 0
  const layout = useMemo(
    () => compareLayout({ ticks: ratioTicks(low, high), band, revision, empty }),
    [low, high, band, revision, empty],
  )

  // Where the plot draws, to outline a bar over it. Nothing drawn depends on it, so that a draw
  // does not ask for another.
  const [geometry, setGeometry] = useState<PlotGeometry | null>(null)
  const indexOf = useMemo(() => new Map(bars.map((bar, i) => [bar.test, i])), [bars])
  const emphasized = useStoreValue(emphasis, (test) =>
    test === null ? undefined : indexOf.get(test),
  )

  const onRelayout = (event: PlotRelayoutEvent) => {
    const range = zoomOf(event)
    if (range !== undefined) setZoom(range)
  }
  const onHover = (event: PlotMouseEvent) => {
    const point = event.points[0]
    const bar = point && drawn.barsOf.get(point.data)?.[point.pointNumber]
    if (bar !== undefined) hovered.set(bar.test)
  }

  return (
    <div className={styles.chartArea}>
      <Chart
        label={empty ? 'Ratio of B to A by test: no data to plot' : 'Ratio of B to A by test'}
        className={styles.chart}
        data={drawn.data}
        layout={layout}
        onHover={onHover}
        onUnhover={() => hovered.set(null)}
        onRelayout={onRelayout}
        onDraw={setGeometry}
      />
      {geometry !== null && emphasized !== undefined && (
        <Outline geometry={geometry} bar={bars[emphasized]} index={emphasized} />
      )}
    </div>
  )
}
