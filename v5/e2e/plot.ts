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
    _size: { l: number; t: number }
    xaxis: { l2p(value: number): number; range: number[] }
    yaxis: { l2p(value: number): number }
  }
  _fullData: { x: number[]; y: number[] }[]
}

/** The plot of the chart in `scope`, once Plotly has drawn it. */
export function plotOf(scope: Page | Locator): Locator {
  return scope.locator('.js-plotly-plot')
}

/** The lines the chart in `scope` draws, one per trace. */
export function tracesOf(scope: Page | Locator): Locator {
  return scope.locator('.scatterlayer .trace')
}
