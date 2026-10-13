/** The metrics the Compare page offers (CP1), and the one it compares. */

import type { UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { SuiteSchema } from '../../api/suites'
import { isNumeric, type Metric } from '../../schema'
import { useDropUnusable } from '../../url-state'

/**
 * The metrics compared between `a` and `b` (CP1): those of the one suite given, or, with two,
 * those both declare alike, numeric, with the same `bigger_is_better` and `unit`. Labelled as the
 * first suite labels them.
 */
export function offeredMetrics(a: SuiteSchema | undefined, b: SuiteSchema | undefined): Metric[] {
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
 * The metrics the two sides' suites offer, and among them the metric `name`, the one selected, once
 * it is known to be offered. One the suites do not offer is dropped (AR2 "State") through `drop`.
 */
export function useMetric(
  a: SuiteSchema | undefined,
  b: SuiteSchema | undefined,
  name: string,
  suites: UseQueryResult<SuiteSchema[]>,
  drop: () => void,
): { offered: Metric[]; metric: Metric | undefined } {
  const offered = useMemo(() => offeredMetrics(a, b), [a, b])
  const metric = offered.find((entry) => entry.name === name)
  useDropUnusable(suites, () => name === '' || metric !== undefined, drop)
  return { offered, metric }
}
