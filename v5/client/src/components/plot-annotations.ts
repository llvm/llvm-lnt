/** Annotations every chart's layout shares. */

import type { Annotations } from 'plotly.js'

/**
 * The annotations saying that a chart has nothing to plot (GR12, CP3): none while it has, and
 * otherwise "No data to plot", centred over the plot, which keeps its axes.
 */
export function noDataAnnotations(empty: boolean): Partial<Annotations>[] {
  return empty
    ? [
        {
          text: 'No data to plot',
          showarrow: false,
          xref: 'paper',
          yref: 'paper',
          x: 0.5,
          y: 0.5,
          font: { size: 16, color: '#6b7280' },
        },
      ]
    : []
}
