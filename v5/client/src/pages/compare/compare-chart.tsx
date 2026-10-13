import { useMemo, useState } from 'react'
import type { PlotMouseEvent, PlotRelayoutEvent } from 'plotly.js'
import { Chart } from '../../components/chart'
import { useStoreValue, type ValueStore } from '../../value-store'
import {
  barTrace,
  chartBars,
  chartExtent,
  compareLayout,
  emphasisShape,
  noiseBand,
  ratioTicks,
} from './chart'
import type { ComparisonRow } from './comparison'
import styles from './compare.module.css'

interface Props {
  /** The compared rows (CP2), which the chart plots those of that it can. */
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

/** The y-axis range the user zoomed to, and the comparison it was zoomed on. */
interface Zoom {
  revision: string
  range: [number, number]
}

/** The y-axis range a relayout zoomed to, null for a reset, undefined for neither. */
function zoomOf(event: PlotRelayoutEvent): [number, number] | null | undefined {
  if (event['yaxis.autorange']) return null
  const low = event['yaxis.range[0]']
  const high = event['yaxis.range[1]']
  return typeof low === 'number' && typeof high === 'number' ? [low, high] : undefined
}

/**
 * The comparison's chart (CP3): a bar per compared test, by ratio, on a log2 axis labelled with the
 * percentage changes, and the Delta % knob's noise band. Its ticks follow a zoom of the y-axis.
 * Hovering a bar highlights its test's row, and hovering a row outlines its bar (CP5).
 */
export function CompareChart({ rows, noisePct, revision, emphasis, hovered }: Props) {
  const bars = useMemo(() => chartBars(rows), [rows])
  const data = useMemo(() => [barTrace(bars)], [bars])
  // The bar of the test hovered in the table, outlined (CP5).
  const indexOf = useMemo(() => new Map(bars.map((bar, i) => [bar.test, i])), [bars])
  const emphasized = useStoreValue(emphasis, (test) => (test === null ? undefined : indexOf.get(test)))
  const outline = useMemo(
    () => (emphasized === undefined ? undefined : emphasisShape(bars[emphasized], emphasized)),
    [bars, emphasized],
  )

  const band = useMemo(() => (noisePct === null ? null : noiseBand(noisePct)), [noisePct])
  const [zoom, setZoom] = useState<Zoom | null>(null)
  const zoomed = zoom !== null && zoom.revision === revision ? zoom.range : null
  const extent = useMemo(() => chartExtent(bars, band), [bars, band])
  const [low, high] = zoomed ?? extent
  const empty = bars.length === 0
  const layout = useMemo(
    () => compareLayout({ ticks: ratioTicks(low, high), band, revision, empty, emphasis: outline }),
    [low, high, band, revision, empty, outline],
  )

  const onRelayout = (event: PlotRelayoutEvent) => {
    const range = zoomOf(event)
    if (range !== undefined) setZoom(range === null ? null : { revision, range })
  }
  const onHover = (event: PlotMouseEvent) => {
    const bar = bars[event.points[0]?.pointNumber]
    if (bar !== undefined) hovered.set(bar.test)
  }

  return (
    <Chart
      label={empty ? 'Ratio of B to A by test: no data to plot' : 'Ratio of B to A by test'}
      className={styles.chart}
      data={data}
      layout={layout}
      onHover={onHover}
      onUnhover={() => hovered.set(null)}
      onRelayout={onRelayout}
    />
  )
}
