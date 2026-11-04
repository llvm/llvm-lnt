/** Annotations every chart's layout shares. */

import type { Annotations } from 'plotly.js'

/**
 * The annotations saying that a chart has nothing to plot (GR12, CP3): none while it has, and
 * otherwise "No data to plot", centred over the plot, which keeps its axes -- or at height `y` of
 * the plot, from 0 at the bottom to 1 at the top, such as the middle of one of its panels.
 */
export function noDataAnnotations(empty: boolean, y = 0.5): Partial<Annotations>[] {
  return empty
    ? [
        {
          text: 'No data to plot',
          showarrow: false,
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y,
          font: { size: 16, color: '#6b7280' },
        },
      ]
    : []
}
