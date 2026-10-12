/** Reading the Plotly charts of the web UI (see client/src/components/chart.tsx). */

import type { Locator, Page } from '@playwright/test'

/**
 * The parts of a Plotly plot that place its points on the page, and the range of its x-axis. They
 * are Plotly internals, but the only way to find where a given point is drawn: the SVG holds each
 * trace as one path, without its points, and a hover label only shows once the pointer is within a
 * few pixels of one.
 */
export interface PlotDiv extends HTMLElement {
  _fullLayout: {
    xaxis: PlotAxis & { range: number[] }
    yaxis: PlotAxis
    /** The axis of what a chart draws over its plot, such as the Graph's regressions. */
    yaxis2?: PlotAxis
  }
  _fullData: { name: string; x: (number | string)[]; y: number[]; yaxis: string }[]
}

interface PlotAxis {
  /** Where a value of the axis is drawn, from the start of the axis. */
  d2p(value: number | string): number
  /** Where the axis starts, in the plot. */
  _offset: number
}

/**
 * Where point `index` of a trace of the chart in `scope` -- the `trace`th, or the one named
 * `trace` -- is drawn, relative to the plot rather than to the page, so that acting there through
 * the plot's locator finds the point wherever the plot is, as content above it loads.
 */
export function pointOf(scope: Page | Locator, trace: number | string, index: number) {
  return plotOf(scope).evaluate(
    (element, [trace, index]) => {
      const { _fullLayout: layout, _fullData: drawn } = element as PlotDiv
      const data = typeof trace === 'number' ? drawn[trace] : drawn.find((d) => d.name === trace)
      if (data === undefined) throw new Error(`No trace ${trace}`)
      const yaxis = (data.yaxis === 'y2' && layout.yaxis2) || layout.yaxis
      return {
        x: layout.xaxis._offset + layout.xaxis.d2p(data.x[index]),
        y: yaxis._offset + yaxis.d2p(data.y[index]),
      }
    },
    [trace, index] as const,
  )
}

/** The plot of the chart in `scope`, once Plotly has drawn it. */
export function plotOf(scope: Page | Locator): Locator {
  return scope.locator('.js-plotly-plot')
}

/** The lines the chart in `scope` draws, one per trace. */
export function tracesOf(scope: Page | Locator): Locator {
  return scope.locator('.scatterlayer .trace')
}
