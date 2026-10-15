/**
 * The columns of the comparison table (CP2), each defined once for the table's cells, the order its
 * rows are sorted in, and what Copy as CSV writes.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { CellLook } from '../../components/data-table'
import { sortRows, type SortDirection, type SortKey } from '../../components/table-sort'
import { formatNumber, NA, plural } from '../../format'
import {
  LABELS,
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
      {LABELS[status]}
    </span>
  )
}

/** The columns every comparison table shows. */
const COLUMNS: CompareColumn[] = [
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
    csv: (row) => (row.status === 'na' ? null : LABELS[row.status]),
  },
]

/** The optional statistics columns (CP2 "Optional columns"), as `columns` names them (CP7). */
export const OPTIONAL_KEYS = [
  'samples',
  'mean',
  'median',
  'min',
  'max',
  'stddev',
  'cv',
  'pvalue',
] as const

export type OptionalKey = (typeof OPTIONAL_KEYS)[number]

/** An optional statistic: what it is called, how it is shown, and its value, per side or not. */
type Statistic = { label: string; format: (value: number) => string } & (
  | { perSide: true; of: (side: SideStatistics) => number | null }
  | { perSide: false; of: (row: ComparisonRow) => number | null }
)

const toFixed2 = (value: number) => value.toFixed(2)

/** A p-value: below 0.0001, in exponent notation, rather than with dozens of zeros. */
const formatPValue = (value: number) =>
  value !== 0 && value < 1e-4 ? value.toExponential(2) : formatNumber(value)

/** The optional statistics (CP2 "Optional columns"), each over a side's samples for a test. */
const STATISTICS: Record<OptionalKey, Statistic> = {
  samples: { label: 'Samples', format: String, perSide: true, of: (side) => side.count },
  mean: { label: 'Mean', format: formatNumber, perSide: true, of: (side) => side.mean },
  median: { label: 'Median', format: formatNumber, perSide: true, of: (side) => side.median },
  min: { label: 'Min', format: formatNumber, perSide: true, of: (side) => side.min },
  max: { label: 'Max', format: formatNumber, perSide: true, of: (side) => side.max },
  stddev: { label: 'Std dev', format: formatNumber, perSide: true, of: (side) => side.stddev },
  cv: { label: 'CV %', format: toFixed2, perSide: true, of: (side) => side.cv },
  pvalue: { label: 'P-value', format: formatPValue, perSide: false, of: (row) => row.pValue },
}

/** How the Columns menu names the optional statistic `key`. */
export function optionalLabel(key: OptionalKey): string {
  return STATISTICS[key].label
}

/** What the Columns menu says the statistics are computed over (CP2 "Optional columns"). */
export const STATISTICS_OVER = 'Computed over all samples without aggregation.'

/** A statistic of each test, as a column, empty on the geomean row. */
function statisticColumn(
  id: string,
  header: string,
  value: (row: ComparisonRow) => number | null,
  format: (value: number) => string,
): CompareColumn {
  const valueOf = (row: Row) => (row.test === null ? null : value(row))
  return {
    id,
    header,
    looks: ['numeric', 'nowrap'],
    cell: (row) => {
      if (row.test === null) return null
      const statistic = value(row)
      return statistic === null ? NA : format(statistic)
    },
    sortKey: value,
    csv: valueOf,
  }
}

/** The columns of the optional statistic `key`: one per side, A before B, or one for the test. */
function optionalColumns(key: OptionalKey): CompareColumn[] {
  const statistic = STATISTICS[key]
  const { label, format } = statistic
  if (!statistic.perSide) {
    return [statisticColumn(key, label, statistic.of, format)]
  }
  return [
    statisticColumn(`${key}_a`, `${label} A`, (row) => statistic.of(row.statisticsA), format),
    statisticColumn(`${key}_b`, `${label} B`, (row) => statistic.of(row.statisticsB), format),
  ]
}

/**
 * The table's columns with the optional ones `shown`, in the order of `OPTIONAL_KEYS`, between Ratio
 * and Status.
 */
export function tableColumns(shown: readonly OptionalKey[]): CompareColumn[] {
  const optional = OPTIONAL_KEYS.filter((key) => shown.includes(key)).flatMap(optionalColumns)
  return [...COLUMNS.slice(0, -1), ...optional, ...COLUMNS.slice(-1)]
}

/** Every column of the table, whichever optional ones are shown. */
const ALL_COLUMNS = tableColumns(OPTIONAL_KEYS)

/** Every column the table can sort by, as `sort` names them (CP7). */
export const SORTABLE = ALL_COLUMNS.map((column) => column.id)

/** `rows`, sorted by the column `id` in `direction` (see `sortRows`). */
export function sortComparison(
  rows: ComparisonRow[],
  id: string,
  direction: SortDirection,
): ComparisonRow[] {
  const column = ALL_COLUMNS.find((entry) => entry.id === id)
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
