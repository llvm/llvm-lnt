/** The props each chart was last rendered with, in tests that stand in for it (see chart.tsx). */

import type { ChartProps } from '../components/chart'

const drawn = new WeakMap<Element, ChartProps>()

export function record(element: Element | null, props: ChartProps) {
  if (element !== null) drawn.set(element, props)
}

/** The props the chart rendered as `element` was last given. */
export function chartProps(element: Element): ChartProps {
  const props = drawn.get(element)
  if (props === undefined) throw new Error('Not the container of a chart')
  return props
}
