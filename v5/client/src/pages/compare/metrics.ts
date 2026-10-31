/** The metrics the Compare page offers (CP1), and the one it compares. */

import { useMemo } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import type { Suite } from '../../api/suites'
import { isNumeric, type Metric } from '../../schema'
import { useDropUnusable } from '../../url-state'
import type { Settings } from './settings'
import type { Side } from './use-side'

/**
 * The metrics compared between `a` and `b` (CP1): those of the one suite given, or, with two,
 * those both declare alike, numeric, with the same `bigger_is_better` and `unit`. Labelled as the
 * first suite labels them.
 */
export function offeredMetrics(a: Suite | undefined, b: Suite | undefined): Metric[] {
  const [first, second] = a === undefined ? [b, undefined] : [a, b]
  return (first?.metrics ?? []).filter(
    (entry) =>
      isNumeric(entry) &&
      (second === undefined ||
        second.metrics.some(
          (other) =>
            other.name === entry.name &&
            isNumeric(other) &&
            other.bigger_is_better === entry.bigger_is_better &&
            other.unit === entry.unit,
        )),
  )
}

/**
 * The metrics the suites of `a` and `b` offer, and among them the metric `all` selects, once it is
 * known to be offered. One the suites do not offer is dropped (AR2 "State").
 */
export function useMetric(
  a: Side,
  b: Side,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<Suite[]>,
): { offered: Metric[]; metric: Metric | undefined } {
  const offered = useMemo(() => offeredMetrics(a.schema, b.schema), [a.schema, b.schema])
  const metric = offered.find((entry) => entry.name === all.metric)
  useDropUnusable(
    suites,
    () => all.metric === '' || metric !== undefined,
    () => update({ metric: '' }),
  )
  return { offered, metric }
}
