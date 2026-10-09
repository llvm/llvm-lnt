/**
 * How a suite's schema (D4) is presented, following AR2's display conventions.
 */

import type { Schemas } from './api/client'
import type { SuiteSchema } from './api/suites'
import { formatNumber, formatTimestamp, MISSING } from './format'

export type Commit = Schemas['Commit']
export type Metric = SuiteSchema['metrics'][number]

type FieldValue = string | number | null | undefined

/** What a metric, machine field or commit field is labelled with: its display name, if set. */
export function labelOf(entry: { name: string; display_name: string | null }): string {
  return entry.display_name ?? entry.name
}

/** A value of a declared field, as shown: in its JSON form, except timestamps in local time. */
export function formatFieldValue(value: FieldValue, type: Schemas['AttributeType']): string {
  if (value === null || value === undefined) return MISSING
  if (type === 'datetime' && typeof value === 'string') return formatTimestamp(value)
  return String(value)
}

/** Whether `metric` is numeric (D3): what a value axis, or a number's formatting, needs. */
export function isNumeric(metric: Metric): boolean {
  return metric.type === 'real' || metric.type === 'integer'
}

/** The metric a page shows unless told otherwise: the first numeric one, else the first (DT2). */
export function defaultMetric(schema: SuiteSchema): Metric | undefined {
  return schema.metrics.find(isNumeric) ?? schema.metrics[0]
}

/** A metric's value, as shown: a `real` to 6 significant digits (AR2), anything else in full. */
export function formatMetricValue(value: FieldValue, metric: Metric): string {
  if (typeof value === 'number' && metric.type === 'real') return formatNumber(value)
  return formatFieldValue(value, metric.type)
}

/** The suite's metrics, in schema order and by label, as the options of a `Select`. */
export function metricOptions(schema: SuiteSchema): { value: string; label: string }[] {
  return schema.metrics.map((entry) => ({ value: entry.name, label: labelOf(entry) }))
}

/**
 * A commit's display value (AR2): the value of the commit field the schema marks `display`, when
 * the commit has one, and the commit string otherwise, followed by ` (tag)` when the commit has a
 * tag, unless `withTag` is false. It is for display only: links and requests use `commit.value`.
 */
export function commitDisplayValue(
  commit: Commit,
  schema: SuiteSchema,
  { withTag = true }: { withTag?: boolean } = {},
): string {
  const field = schema.commit_fields.find((entry) => entry.display)
  const value = field === undefined ? null : commit.fields[field.name]
  const shown = value === null || value === undefined ? commit.value : String(value)
  return withTag && commit.tag !== null ? `${shown} (${commit.tag})` : shown
}

/**
 * The display value of the commit `value`, from `commits`, which resolved it: `value` itself while
 * it is not among them -- not resolved yet, or deleted since it was named.
 */
export function displayValueOf(
  value: string,
  commits: Map<string, Commit> | undefined,
  schema: SuiteSchema,
): string {
  const commit = commits?.get(value)
  return commit === undefined ? value : commitDisplayValue(commit, schema)
}
