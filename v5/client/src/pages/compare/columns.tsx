/**
 * The columns of the comparison table (CP2), each defined once for the table's cells, the order its
 * rows are sorted in, and what Copy as CSV writes.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { CellLook } from '../../components/data-table'
import { sortRows, type SortDirection, type SortKey } from '../../components/table-sort'
import { formatNumber, plural } from '../../format'
import {
  CATEGORY_LABELS,
  STATUSES,
  type ComparisonRow,
  type NoiseReason,
  type SideStatistics,
  type Status,
  type Values,
} from './comparison'
import { toCsv, type CsvCell } from './csv'
import styles from './compare.module.css'

/** The geomean summary row (CP2), told apart from the tests' rows by the absence of a test. */
export type GeomeanRow = Values & { test: null }

export type Row = ComparisonRow | GeomeanRow

export interface CompareColumn {
  /** How `sort` names the column (CP7). */
  id: string
  header: string
  looks?: readonly CellLook[]
  cell(row: Row): ReactNode
  /** What a test's row is sorted by: null for N/A, which sorts last in both directions. */
  sortKey(row: ComparisonRow): SortKey
  /** What Copy as CSV writes of the row: a number at full precision, null for N/A. */
  csv(row: Row): CsvCell
}

const NA = 'N/A'

/** A side's value, or a difference between them: to at most 6 significant digits (AR6). */
function formatValue(value: number | null): string {
  return value === null ? NA : formatNumber(value)
}

/** Delta %, with its sign, to 2 decimal places. */
export function formatDeltaPct(value: number | null): string {
  if (value === null) return NA
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(2)}%`
}

/** A ratio, to 4 decimal places. */
export function formatRatio(value: number | null): string {
  return value === null ? NA : value.toFixed(4)
}

/** How many samples and runs a side's value of a test comes from (CP2 "Sample count tooltips"). */
function countsOf({ count, runs }: SideStatistics): string {
  return `${plural(count, 'sample')} across ${plural(runs, 'run')}`
}

/** The tooltip of side A's value: none for the geomean, or a side with no value. */
function titleA(row: Row): string | undefined {
  return row.test === null || row.a === null ? undefined : countsOf(row.statisticsA)
}

function titleB(row: Row): string | undefined {
  return row.test === null || row.b === null ? undefined : countsOf(row.statisticsB)
}

/** The tooltip of a value derived from both sides. */
function bothTitle(row: Row): string | undefined {
  if (row.test === null || row.a === null || row.b === null) return undefined
  return `A: ${countsOf(row.statisticsA)}, B: ${countsOf(row.statisticsB)}`
}

/** A column showing a number of the row, sorted by it. */
function numberColumn(
  id: string,
  header: string,
  value: (row: Row) => number | null,
  format: (value: number | null) => string,
  title: (row: Row) => string | undefined,
): CompareColumn {
  return {
    id,
    header,
    looks: ['numeric', 'nowrap'],
    cell: (row) => <span title={title(row)}>{format(value(row))}</span>,
    sortKey: value,
    csv: value,
  }
}

/** Why a knob classified a test as noise, e.g. `Delta 0.31% below 1% threshold` (CP2). */
function describeNoise({ knob, value, threshold }: NoiseReason): string {
  switch (knob) {
    case 'pct':
      return `Delta ${formatNumber(value)}% below ${threshold}% threshold`
    case 'pval':
      return `p-value ${formatNumber(value)} above ${threshold}`
    case 'floor':
      return `max(|A|, |B|) = ${formatNumber(value)} below floor of ${threshold}`
  }
}

/**
 * A row's status, in its colour: green for improved, red for regressed, grey otherwise, and for
 * noise, the knobs that classified it so on hover (CP2).
 */
function statusLabel(status: Status, noise: NoiseReason[] = []): ReactNode {
  return (
    <span
      className={clsx(styles.status, styles[status])}
      title={noise.length > 0 ? noise.map(describeNoise).join('\n') : undefined}
    >
      {CATEGORY_LABELS[status]}
    </span>
  )
}

/** The columns of the comparison table. */
export const COLUMNS: CompareColumn[] = [
  {
    id: 'test',
    header: 'Test',
    cell: (row) => (row.test === null ? <strong>Geomean</strong> : row.test),
    sortKey: (row) => row.test,
    csv: (row) => row.test ?? 'Geomean',
  },
  numberColumn('value_a', 'Value A', (row) => row.a, formatValue, titleA),
  numberColumn('value_b', 'Value B', (row) => row.b, formatValue, titleB),
  numberColumn('delta', 'Delta', (row) => row.delta, formatValue, bothTitle),
  numberColumn('delta_pct', 'Delta %', (row) => row.deltaPct, formatDeltaPct, bothTitle),
  numberColumn('ratio', 'Ratio', (row) => row.ratio, formatRatio, bothTitle),
  {
    id: 'status',
    header: 'Status',
    looks: ['nowrap'],
    cell: (row) => statusLabel(row.status, row.test === null ? undefined : row.noise),
    // N/A after every other status, in both directions, as a row without a value is.
    sortKey: (row) => (row.status === 'na' ? null : STATUSES.indexOf(row.status)),
    csv: (row) => (row.status === 'na' ? null : CATEGORY_LABELS[row.status]),
  },
]

/** Every column the table can sort by, as `sort` names them (CP7). */
export const SORTABLE = COLUMNS.map((column) => column.id)

/** `rows`, sorted by the column `id` in `direction` (see `sortRows`). */
export function sortComparison(
  rows: ComparisonRow[],
  id: string,
  direction: SortDirection,
): ComparisonRow[] {
  const column = COLUMNS.find((entry) => entry.id === id)
  return column === undefined ? rows : sortRows(rows, column.sortKey, direction)
}

/** The compared rows as CSV (CP2 "Copy as CSV"): the columns' headers, the geomean, the rows. */
export function comparisonCsv(
  columns: readonly CompareColumn[],
  geomean: Values,
  rows: readonly ComparisonRow[],
): string {
  const geomeanRow: GeomeanRow = { ...geomean, test: null }
  return toCsv([
    columns.map((column) => column.header),
    columns.map((column) => column.csv(geomeanRow)),
    ...rows.map((row) => columns.map((column) => column.csv(row))),
  ])
}
