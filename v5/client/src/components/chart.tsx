import { useEffect, useEffectEvent, useRef, useState } from 'react'
import type {
  Config,
  Data,
  Layout,
  PlotHoverEvent,
  PlotMouseEvent,
  PlotRelayoutEvent,
} from 'plotly.js'
import { Alert } from './feedback'

type Plotly = typeof import('plotly.js-basic-dist-min').default

/**
 * Where a plot draws, in pixels from the top left of the chart's container: the plotting area, and
 * the position of a value on each axis -- on a category axis, of a category's index.
 */
export interface PlotGeometry {
  area: { left: number; top: number; width: number; height: number }
  x(value: number): number
  y(value: number): number
}

/** The parts of Plotly's own state of a plot that place what it draws (see `geometryOf`). */
interface DrawnPlot {
  _fullLayout?: {
    _size: { l: number; t: number; w: number; h: number }
    xaxis?: DrawnAxis
    yaxis?: DrawnAxis
  }
}

interface DrawnAxis {
  l2p(value: number): number
  _offset: number
}

/**
 * Where the plot drawn in `div` draws, read from Plotly's state of it. That state is internal to
 * Plotly, but there is no other way to place something over a point: the SVG draws each trace as
 * one path, without its points.
 */
function geometryOf(div: HTMLElement): PlotGeometry | null {
  const layout = (div as DrawnPlot)._fullLayout
  // A plot purged, or not drawn yet, has no axes.
  if (layout?.xaxis === undefined || layout.yaxis === undefined) return null
  const { _size: size, xaxis, yaxis } = layout
  return {
    area: { left: size.l, top: size.t, width: size.w, height: size.h },
    x: (value) => xaxis.l2p(value) + xaxis._offset,
    y: (value) => yaxis.l2p(value) + yaxis._offset,
  }
}

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
   * from the API, such as a machine or test name, goes through `escapeHtml` (see format.ts). In a
   * `hovertemplate`, Plotly also reads `%{...}` as a field to fill, so such text is never written
   * into the template: it is passed as `customdata` (or `text`) and named by a field, which Plotly
   * fills in a single pass, without reading the values it fills in. Escaped, they cannot form the
   * template's `<extra>` part either. Setting `meta` would make Plotly read `%{...}` in names,
   * titles and annotations too, so no chart sets it.
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
  /**
   * A point was clicked: the one whose hover label shows. Returns `true` when the click opened
   * something over the point, such as its details, which then take the place of its hover label.
   */
  onClick?(event: PlotMouseEvent): boolean | void
  /**
   * The plot was drawn, after a change to what it draws, a zoom, or a resize: where it draws now.
   * Something placed over the plot with it is placed again here. What the chart draws must not
   * depend on it, or each draw would ask for another.
   */
  onDraw?(geometry: PlotGeometry): void
  /** The user zoomed or panned the plot, or reset its zoom. */
  onRelayout?(event: PlotRelayoutEvent): void
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
  // Where the plot was last reported to draw, so that a draw that moves nothing reports nothing.
  const drawnAt = useRef('')
  const onDraw = useEffectEvent((div: HTMLElement) => {
    const geometry = geometryOf(div)
    if (geometry === null) return
    const { area, x, y } = geometry
    const at = [area.left, area.top, area.width, area.height, x(0), x(1), y(0), y(1)].join()
    if (at === drawnAt.current) return
    drawnAt.current = at
    events.onDraw?.(geometry)
  })
  const onRelayout = useEffectEvent((event: PlotRelayoutEvent) => {
    // A resize relayouts the plot too, with nothing but its new size.
    const keys = Object.keys(event)
    if (keys.every((key) => key === 'autosize' || key === 'width' || key === 'height')) return
    events.onRelayout?.(event)
  })

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
        if (!state.live) return
        // A zoom or a resize draws again too, which the listener below reports.
        onDraw(div)
        if (state.ready) return
        state.ready = true
        plot.on('plotly_hover', (event) => onHover(event))
        plot.on('plotly_unhover', (event) => onUnhover(event))
        plot.on('plotly_click', (event) => {
          if (onClick(event) === true) library.Fx.unhover(div)
        })
        // A draw under way when the plot is freed ends after it, with nothing left to report.
        plot.on('plotly_afterplot', () => {
          if (state.live) onDraw(div)
        })
        plot.on('plotly_relayout', (event) => onRelayout(event))
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
