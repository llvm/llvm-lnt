import { useMemo } from 'react'
import { DataTable, type Column } from '../../components/data-table'
import type { TableSort } from '../../components/table-sort'
import type { CompareColumn, GeomeanRow, Row } from './columns'
import type { ComparisonRow, Values } from './comparison'
import styles from './compare.module.css'

const testOf = (row: Row) => row.test ?? ''

/** What the table shows, computed from the comparison (see `useComparisonTable`). */
export interface TableView {
  /** The rows the table shows, in the order they are sorted in. */
  rows: ComparisonRow[]
  columns: CompareColumn[]
  /** The summary message: how many rows are shown, of how many. */
  summary: string
  geomean: Values
  /** What the table says when it has no row, and why. */
  empty: string
  sort: TableSort
  onSort(sort: TableSort): void
}

/**
 * The comparison table (CP2): a row per test, with each side's value, how they differ and the
 * test's status, sorted by any column, with the geomean summary row first.
 */
export function CompareTable({
  rows,
  columns: shownColumns,
  summary,
  geomean,
  empty,
  sort,
  onSort,
}: TableView) {
  const columns = useMemo(
    () =>
      shownColumns.map((column): Column<Row> => ({
        id: column.id,
        header: column.header,
        looks: column.looks,
        cell: column.cell,
        // Only says that the column can be sorted by: the rows come sorted (see `sortComparison`).
        sortKey: () => null,
      })),
    [shownColumns],
  )
  // Shown first whatever the sort, and only while the table has other rows (see `DataTable`).
  const pinned = useMemo((): GeomeanRow[] => [{ ...geomean, test: null }], [geomean])

  return (
    <>
      <p className={styles.count} role="status">
        {summary}
      </p>
      <DataTable
        label="Comparison"
        columns={columns}
        rows={rows}
        rowKey={testOf}
        pinned={pinned}
        empty={empty}
        sort={sort}
        onSort={onSort}
        presorted
      />
    </>
  )
}
