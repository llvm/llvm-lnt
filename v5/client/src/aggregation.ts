/**
 * The ways several values are combined into one: a test's samples within a run, or the runs at a
 * commit (GR1, CP2). They are the API's sample aggregations (E9), so that the client combines
 * values the way the server does.
 */

import type { Schemas } from './api/client'

export type Aggregation = Schemas['SampleAggregation']

/** Every aggregation, the default first. */
export const AGGREGATIONS: readonly Aggregation[] = ['median', 'mean', 'min', 'max']

/** The median of `sorted`, which is sorted: the mean of the middle two for an even count (O9). */
function median(sorted: number[]): number {
  const middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** The arithmetic mean of `values`, at least one. */
export function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** `values`, at least one, combined into one with `how`. */
export function aggregate(values: readonly number[], how: Aggregation): number {
  switch (how) {
    case 'median':
      return median([...values].sort((a, b) => a - b))
    case 'mean':
      return mean(values)
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
  }
}
