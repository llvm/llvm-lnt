/**
 * How a suite's schema (D4) is presented, following AR2's display conventions.
 */

import type { Schemas } from './api/client'
import type { SuiteSchema } from './api/suites'
import { formatTimestamp, MISSING } from './format'

export type Commit = Schemas['Commit']

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
