/**
 * A stand-in for components/chart.tsx, which tests put in its place, since Plotly cannot draw in
 * jsdom: `vi.mock('.../components/chart', () => import('.../test/chart'))`. It renders the chart's
 * container, and records the props it was last rendered with, which `chartProps` (see
 * test/chart-props.ts) reads back: what the page hands Plotly to draw.
 */

import type { ChartProps } from '../components/chart'
import { record } from './chart-props'

export function Chart(props: ChartProps) {
  return <div role="img" aria-label={props.label} ref={(element) => record(element, props)} />
}
