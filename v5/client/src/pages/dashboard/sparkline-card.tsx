import { useMemo, useState } from 'react'
import { flushSync } from 'react-dom'
import type { Config, Data, Layout, PlotMouseEvent } from 'plotly.js'
import { Link } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import clsx from 'clsx'
import { refOf, type Suite, type SuiteRef } from '../../api/suites'
import { useTrends, type TrendPoint } from '../../api/trends'
import { DisabledLink } from '../../components/button-link'
import { Chart } from '../../components/chart'
import { ErrorMessage, Loading } from '../../components/feedback'
import { graphPath } from '../../paths'
import { displayValueOf, formatUnit, labelOf, type Metric } from '../../schema'
import { plotlyTraces, sparklineDescription, sparklineTraces } from './sparkline'
import styles from './dashboard.module.css'

interface Props {
  schema: Suite
  metric: Metric
  /** The machines the suite's cards show, chosen once for all of them (DA2). */
  machines: string[]
  /** How many of the most recent commits the card covers. */
  range: number
}

/** A card of the Dashboard (DA2): the trend of one metric on the suite's machines. */
export function SparklineCard({ schema, metric, machines, range }: Props) {
  const suite = refOf(schema)
  const trends = useTrends(suite, { metric: metric.name, machines, lastN: range })
  const shown = useMemo(() => {
    if (trends.data === undefined) return undefined
    const { items, commits } = trends.data
    const traces = sparklineTraces(items, machines)
    const displayValue = (point: TrendPoint) =>
      displayValueOf(point.commit, commits, schema, point.tag)
    return {
      machines: traces.map((trace) => trace.machine),
      data: plotlyTraces(traces, displayValue, metric),
      description: sparklineDescription(traces, displayValue, metric),
    }
  }, [trends.data, machines, schema, metric])
  const traced = shown?.machines ?? []
  const title = labelOf(metric)
  const unit = formatUnit(metric)

  let body
  // Why the title leads nowhere for now (AR8), while the card has no chart.
  let unlinked: string | null = null
  if (trends.isError) {
    unlinked = 'The trend could not be loaded.'
    body = (
      <div className={styles.placeholder}>
        <ErrorMessage error={trends.error} onRetry={() => void trends.refetch()} />
      </div>
    )
  } else if (shown === undefined) {
    unlinked = 'The trend is loading.'
    body = (
      <div className={styles.placeholder}>
        <Loading />
      </div>
    )
  } else if (traced.length === 0) {
    unlinked = 'No machine has a trend for this metric.'
    body = <p className={clsx(styles.placeholder, styles.note)}>{unlinked}</p>
  } else {
    body = (
      <>
        <VisuallyHidden elementType="p">{shown.description}</VisuallyHidden>
        <Sparkline suite={suite} metric={metric} machines={traced} data={shown.data} />
      </>
    )
  }

  return (
    <article className={styles.card} aria-label={title}>
      <h3 className={styles.title}>
        {unlinked === null ? (
          <Link to={graphPath({ suite, machines: traced, metric: metric.name })}>{title}</Link>
        ) : (
          <DisabledLink title={unlinked}>{title}</DisabledLink>
        )}
        {unit !== null && <span className={styles.unit}> — {unit}</span>}
      </h3>
      {body}
    </article>
  )
}

interface SparklineProps {
  suite: SuiteRef
  metric: Metric
  /** The machines with a trace, in the order of the traces. */
  machines: string[]
  /** The traces, as Plotly draws them. */
  data: Data[]
}

/**
 * The chart of a card, a link to the Graph with every machine it shows, or with only the machine of
 * the trace whose hover label shows (DA2). Being a link, it opens in a new tab on a modified click
 * (AR2 "Routing"). It is only a way to narrow the card's link to one machine with the pointer, so
 * it is hidden from assistive technology and left out of the tab order: the card's title is the
 * same link, and its description says what the chart shows.
 */
function Sparkline({ suite, metric, machines, data }: SparklineProps) {
  const [hovered, setHovered] = useState<string | null>(null)
  const machineOf = (event: PlotMouseEvent) => machines[event.points[0]?.curveNumber] ?? null
  const linked = hovered === null ? machines : [hovered]

  return (
    <Link
      className={styles.chartLink}
      to={graphPath({ suite, machines: linked, metric: metric.name })}
      tabIndex={-1}
      aria-hidden="true"
      // Pressing the chart and moving a little would drag the link rather than click it.
      draggable={false}
    >
      <Chart
        label={`${labelOf(metric)} trend`}
        className={styles.chart}
        data={data}
        layout={LAYOUT}
        config={CONFIG}
        onHover={(event) => setHovered(machineOf(event))}
        onUnhover={() => setHovered(null)}
        // Plotly reports a click on a point, the one whose hover label shows, before the link gets
        // the click: as one Plotly sends it afterwards, or, with Control held, as the browser's
        // own. React renders the link a hover changes some time after Plotly reports the hover, so
        // the link could still lead elsewhere when the click arrives: rendering it now,
        // synchronously, has it lead to that point's machine.
        onClick={(event) => flushSync(() => setHovered(machineOf(event)))}
      />
    </Link>
  )
}

const LAYOUT: Partial<Layout> = {
  margin: { t: 6, r: 6, b: 6, l: 6 },
  // The x-axis is a position among commits, which no label would make sense of (DA2).
  xaxis: { showticklabels: false, showgrid: false, zeroline: false, fixedrange: true },
  yaxis: { automargin: true, fixedrange: true, zeroline: false, nticks: 4, tickfont: { size: 10 } },
  showlegend: false,
  hovermode: 'closest',
  dragmode: false,
  paper_bgcolor: 'rgba(0,0,0,0)',
  plot_bgcolor: 'rgba(0,0,0,0)',
}

const CONFIG: Partial<Config> = { displayModeBar: false, doubleClick: false, scrollZoom: false }
