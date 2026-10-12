import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type { Config, Data, Layout, PlotHoverEvent, PlotMouseEvent } from 'plotly.js'
import { Alert } from './feedback'

type Plotly = typeof import('plotly.js-basic-dist-min').default

/** Plotly, once loaded, so that a chart shown afterwards draws without waiting a render for it. */
let loaded: Plotly | null = null

/**
 * Plotly, fetched as soon as a page with a chart loads, so that it downloads while the page fetches
 * its data: it is large, and only the pages with a chart need it, so it is a chunk of its own (AR2
 * "Code splitting").
 */
const plotly = import('plotly.js-basic-dist-min').then((module) => (loaded = module.default))
// A failure is reported by the charts waiting for it.
plotly.catch(() => {})

export interface ChartProps {
  /** The chart's accessible name. */
  label: string
  /**
   * What to draw. The chart is redrawn whenever one of these is a new object, so a caller memoizes
   * them. A redraw keeps what the user did to the chart (a zoom, say) when the layout's
   * `uirevision` is unchanged.
   *
   * Plotly writes into the objects it draws, so `data` must be neither frozen nor shared with
   * another chart. `layout` may be either: Plotly is given a copy of it.
   *
   * Plotly reads the text it draws -- names, hover labels, titles -- as a subset of HTML, so text
   * from the API, such as a machine or test name, goes through `escapeHtml` (see format.ts).
   */
  data: Data[]
  layout: Partial<Layout>
  config?: Partial<Config>
  /** The container's class, which must give it a height: Plotly fills the container. */
  className: string
  /** The pointer is over a point, which Plotly also shows the hover label of. */
  onHover?(event: PlotHoverEvent): void
  /** The pointer has left the point it was over. */
  onUnhover?(event: PlotMouseEvent): void
  /** A point was clicked: the one whose hover label shows. */
  onClick?(event: PlotMouseEvent): void
}

/**
 * A Plotly chart, drawn once Plotly has loaded, redrawn in place when what it draws changes,
 * resized with its container, and freed when it unmounts.
 *
 * If Plotly cannot be loaded, typically because a deploy replaced its chunk, the chart throws, so
 * that the page's error boundary says once to reload the page, rather than every chart on it.
 */
export function Chart({
  label,
  data,
  layout,
  config,
  className,
  ...events
}: ChartProps) {
  const container = useRef<HTMLDivElement>(null)
  const [library, setLibrary] = useState(loaded)
  const [loadFailure, setLoadFailure] = useState<{ error: unknown } | null>(null)
  const [drawFailed, setDrawFailed] = useState(false)

  // The handlers of the latest render, so that a new handler needs no new listener.
  const onHover = useEffectEvent((event: PlotHoverEvent) => events.onHover?.(event))
  const onUnhover = useEffectEvent((event: PlotMouseEvent) => events.onUnhover?.(event))
  const onClick = useEffectEvent((event: PlotMouseEvent) => events.onClick?.(event))

  useEffect(() => {
    if (library === null) plotly.then(setLibrary, (error: unknown) => setLoadFailure({ error }))
  }, [library])

  // What lives as long as the plot: the observer of its size, and its listeners, added once the
  // first draw has made the container a plot. `end` tears it all down, on unmount or once a draw
  // has failed.
  const session = useRef<{ live: boolean; ready: boolean; end(): void } | null>(null)
  useEffect(() => {
    const div = container.current
    if (library === null || div === null) return
    const observer = new ResizeObserver(() => {
      // Rejected while the plot is not displayed, which leaves nothing to resize.
      if (state.ready) library.Plots.resize(div).catch(() => {})
    })
    const state = {
      live: true,
      ready: false,
      end() {
        if (!state.live) return
        state.live = false
        observer.disconnect()
        library.purge(div)
      },
    }
    session.current = state
    observer.observe(div)
    return state.end
  }, [library])

  useEffect(() => {
    const div = container.current
    const state = session.current
    if (library === null || div === null || state === null) return
    library.react(div, data, structuredClone(layout), { displaylogo: false, ...config }).then(
      (plot) => {
        if (!state.live || state.ready) return
        state.ready = true
        plot.on('plotly_hover', (event) => onHover(event))
        plot.on('plotly_unhover', (event) => onUnhover(event))
        plot.on('plotly_click', (event) => onClick(event))
      },
      () => {
        if (!state.live) return
        state.end()
        setDrawFailed(true)
      },
    )
  }, [library, data, layout, config])

  if (loadFailure !== null) throw loadFailure.error
  if (drawFailed) return <Alert>The chart could not be drawn.</Alert>
  return (
    <div ref={container} className={className} role="img" aria-label={label} />
  )
}
