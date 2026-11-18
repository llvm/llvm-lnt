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
  pValueOf,
  STATUSES,
  type Change,
  type ComparisonRow,
  type Interval,
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
  /**
   * The columns Copy as CSV writes for it: one with its header, but for the CI. Each writes a
   * number at full precision, null for N/A.
   */
  csv: CsvColumn[]
}

/** A column Copy as CSV writes: its header, and what it writes of a row. */
interface CsvColumn {
  header: string
  value(row: Row): CsvCell
}

/** A side's value, or a difference between them, as AR6 shows a measured value. */
function formatValue(value: number | null): string {
  return value === null ? NA : formatNumber(value)
}

/**
 * Delta %, with its sign, to 2 decimal places. An infinite one, which only the bound of a
 * confidence interval can be, is `+∞%`.
 */
export function formatDeltaPct(value: number | null): string {
  if (value === null) return NA
  const magnitude = Number.isFinite(value) ? Math.abs(value).toFixed(2) : '∞'
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${magnitude}%`
}

/** The percentage change of a logarithm of a ratio. */
const percentOf = (log: number) => Math.expm1(log) * 100

/**
 * A confidence interval, as its estimate and its bounds in brackets, each a percentage change as
 * Delta % is shown: `+58.12% [-16.03%, +197.40%]` (CP2 "Optional columns").
 */
export function formatInterval({ estimate, low, high }: Interval): string {
  const [e, l, h] = [estimate, low, high].map((log) => formatDeltaPct(percentOf(log)))
  return `${e} [${l}, ${h}]`
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
    csv: [{ header, value }],
  }
}

/** The words saying where a confidence interval lies against the margin, by the status it gives. */
const AGAINST_MARGIN: Partial<Record<Status, string>> = {
  improved: 'beyond the margin',
  regressed: 'beyond the margin',
  unchanged: 'within the margin',
  inconclusive: 'straddles an edge of the margin',
}

/**
 * What a test's status says of its change (CP2 "Status colors"): its confidence interval and where
 * it lies against the margin, or why it has none. Nothing for a test that cannot be compared.
 */
export function describeStatus(status: Status, change: Change): string | undefined {
  if (status === 'na') return undefined
  switch (change.kind) {
    case 'interval':
      return `${change.confidence}% CI: ${formatInterval(change)}, ${AGAINST_MARGIN[status]}`
    case 'runs': {
      const where = change.sides === 'both' ? 'each side' : `side ${change.sides}`
      return `Only 1 run on ${where}: a CI needs at least 2 runs on each side`
    }
    case 'nonPositive':
      return "A run's value is 0 or negative: the change has no CI"
  }
}

/**
 * A row's status, in its colour: green for improved, red for regressed, amber for inconclusive,
 * grey otherwise, and `detail` on hover (CP2).
 */
function statusLabel(status: Status, detail?: string): ReactNode {
  return (
    <span className={clsx(styles.status, styles[status])} title={detail}>
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
    csv: [{ header: 'Test', value: (row) => row.test ?? 'Geomean' }],
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
    cell: (row) =>
      statusLabel(
        row.status,
        row.test === null ? undefined : describeStatus(row.status, row.change),
      ),
    // N/A after every other status, in both directions, as a row without a value is.
    sortKey: (row) => (row.status === 'na' ? null : STATUSES.indexOf(row.status)),
    csv: [
      { header: 'Status', value: (row) => (row.status === 'na' ? null : LABELS[row.status]) },
    ],
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
  'ci',
  'pvalue',
] as const

export type OptionalKey = (typeof OPTIONAL_KEYS)[number]

/** The optional columns that are statistics of the samples, or the p-value: all but `ci`. */
type StatisticKey = Exclude<OptionalKey, 'ci'>

/** An optional statistic: what it is called, how it is shown, and its value, per side or not. */
type Statistic = { label: string; format: (value: number) => string } & (
  | { perSide: true; of: (side: SideStatistics) => number | null }
  | { perSide: false; of: (row: ComparisonRow) => number | null }
)

const toFixed2 = (value: number) => value.toFixed(2)

/** The optional statistics (CP2 "Optional columns"). */
const STATISTICS: Record<StatisticKey, Statistic> = {
  samples: { label: 'Samples', format: String, perSide: true, of: (side) => side.count },
  mean: { label: 'Mean', format: formatNumber, perSide: true, of: (side) => side.mean },
  median: { label: 'Median', format: formatNumber, perSide: true, of: (side) => side.median },
  min: { label: 'Min', format: formatNumber, perSide: true, of: (side) => side.min },
  max: { label: 'Max', format: formatNumber, perSide: true, of: (side) => side.max },
  stddev: { label: 'Std dev', format: formatNumber, perSide: true, of: (side) => side.stddev },
  cv: { label: 'CV %', format: toFixed2, perSide: true, of: (side) => side.cv },
  pvalue: {
    label: 'P-value',
    format: formatNumber,
    perSide: false,
    of: (row) => pValueOf(row.change),
  },
}

/** How the Columns menu names the optional column `key`. */
export function optionalLabel(key: OptionalKey): string {
  return key === 'ci' ? 'CI' : STATISTICS[key].label
}

/** What the Columns menu says the optional columns are computed over (CP2 "Optional columns"). */
export const STATISTICS_OVER =
  'Samples to CV % are computed over all samples, without aggregation; ' +
  "CI and P-value over the runs' values."

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
    csv: [{ header, value: valueOf }],
  }
}

/** A test's confidence interval, or null where it has none, as on the geomean row. */
function shownInterval(row: Row): Interval | null {
  return row.test === null || row.change.kind !== 'interval' ? null : row.change
}

/**
 * The CI column, at `confidence`, a percentage (CP2 "Optional columns"), which Copy as CSV writes
 * as three columns: the estimate and the bounds, each a percentage change.
 */
function intervalColumn(confidence: number): CompareColumn {
  const percent = (part: 'estimate' | 'low' | 'high') => (row: Row) => {
    const interval = shownInterval(row)
    return interval === null ? null : percentOf(interval[part])
  }
  return {
    id: 'ci',
    header: `${confidence}% CI`,
    looks: ['numeric', 'nowrap'],
    cell: (row) => {
      if (row.test === null) return null
      const interval = shownInterval(row)
      return interval === null ? NA : formatInterval(interval)
    },
    sortKey: (row) => shownInterval(row)?.estimate ?? null,
    csv: [
      { header: 'CI estimate %', value: percent('estimate') },
      { header: `${confidence}% CI low %`, value: percent('low') },
      { header: `${confidence}% CI high %`, value: percent('high') },
    ],
  }
}

/**
 * The columns of the optional column `key`: one per side, A before B, or one for the test, at
 * `confidence` for the CI.
 */
function optionalColumns(key: OptionalKey, confidence: number): CompareColumn[] {
  if (key === 'ci') return [intervalColumn(confidence)]
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
 * and Status, the CI at `confidence`, a percentage, if it is shown.
 */
export function tableColumns(shown: readonly OptionalKey[], confidence: number): CompareColumn[] {
  const optional = OPTIONAL_KEYS.filter((key) => shown.includes(key)).flatMap((key) =>
    optionalColumns(key, confidence),
  )
  return [...COLUMNS.slice(0, -1), ...optional, ...COLUMNS.slice(-1)]
}

/** Every column of the table, whichever optional ones are shown, at any confidence. */
const ALL_COLUMNS = tableColumns(OPTIONAL_KEYS, NaN)

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
  const written = columns.flatMap((column) => column.csv)
  return toCsv([
    written.map((column) => column.header),
    written.map((column) => column.value(geomeanRow)),
    ...rows.map((row) => written.map((column) => column.value(row))),
  ])
}
