import { useMemo } from 'react'
import clsx from 'clsx'
import { DataTable, type Column } from '../../components/data-table'
import type { SortKey, TableSort } from '../../components/table-sort'
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
import styles from './compare.module.css'

/** The geomean summary row (CP2), told apart from the tests' rows by the absence of a test. */
type GeomeanRow = Values & { test: null }

type Row = ComparisonRow | GeomeanRow

const NA = 'N/A'

/** A side's value, or a difference between them: to at most 6 significant digits (AR6). */
function formatValue(value: number | null): string {
  return value === null ? NA : formatNumber(value)
}

/** Delta %, with its sign, to 2 decimal places. */
function formatDeltaPct(value: number | null): string {
  if (value === null) return NA
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${Math.abs(value).toFixed(2)}%`
}

/** A ratio, to 4 decimal places. */
function formatRatio(value: number | null): string {
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

/** A column showing a number of the row, sorted by it, N/A rows last. */
function numberColumn(
  id: string,
  header: string,
  value: (row: Row) => number | null,
  format: (value: number | null) => string,
  title: (row: Row) => string | undefined,
): Column<Row> {
  return {
    id,
    header,
    looks: ['numeric', 'nowrap'],
    cell: (row) => <span title={title(row)}>{format(value(row))}</span>,
    sortKey: (row) => value(row),
  }
}

const COLUMNS: Column<Row>[] = [
  {
    id: 'test',
    header: 'Test',
    cell: (row) => (row.test === null ? <strong>Geomean</strong> : row.test),
    sortKey: (row) => row.test,
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
    cell: (row) => (
      <StatusLabel status={row.status} noise={row.test === null ? undefined : row.noise} />
    ),
    // N/A after every other status, in both directions, as a row without a value is.
    sortKey: (row): SortKey => (row.status === 'na' ? null : STATUSES.indexOf(row.status)),
  },
]

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
function StatusLabel({ status, noise = [] }: { status: Status; noise?: NoiseReason[] }) {
  return (
    <span
      className={clsx(styles.status, styles[status])}
      title={noise.length > 0 ? noise.map(describeNoise).join('\n') : undefined}
    >
      {CATEGORY_LABELS[status]}
    </span>
  )
}

const testOf = (row: Row) => row.test ?? ''

interface Props {
  /** The rows the table shows, by test name. */
  rows: ComparisonRow[]
  geomean: Values
  /** How many tests the comparison holds, without the noise when it is hidden. */
  total: number
  /** Whether the test filter is set. */
  filtered: boolean
  /** What the table says when it has no row, and why. */
  empty: string
  /** Whether the rows are about to be replaced, by those of another classification of the noise. */
  busy: boolean
  sort: TableSort
  onSort(sort: TableSort): void
}

/**
 * The comparison table (CP2): a row per test, each side's value, how they differ, and the test's
 * status, sorted by any column, with the geomean summary row first whatever the sort.
 */
export function CompareTable({ rows, geomean, total, filtered, empty, busy, sort, onSort }: Props) {
  // Shown only while the table has other rows (see `DataTable`).
  const pinned = useMemo((): GeomeanRow[] => [{ ...geomean, test: null }], [geomean])
  return (
    <>
      <p className={styles.count} role="status">
        {filtered
          ? `${rows.length} of ${rows.length} matching tests shown (${total} total)`
          : `${rows.length} of ${total} tests shown`}
      </p>
      <DataTable
        label="Comparison"
        columns={COLUMNS}
        rows={rows}
        rowKey={testOf}
        pinned={pinned}
        empty={empty}
        busy={busy}
        sort={sort}
        onSort={onSort}
      />
    </>
  )
}
