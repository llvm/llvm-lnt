import { useCallback, useLayoutEffect, useMemo, useState, type MouseEvent } from 'react'
import { CopyButton } from '../../components/copy-button'
import { DataTable, type Column } from '../../components/data-table'
import type { RowSelection } from '../../components/range-selection'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import type { TableSort } from '../../components/table-sort'
import { useStoreValue, ValueStore } from '../../value-store'
import { COLUMNS, type CompareColumn, type GeomeanRow, type Row } from './columns'
import type { ComparisonRow, Values } from './comparison'
import styles from './compare.module.css'

/**
 * The geomean summary row, which the table shows first whatever the sort, and only while it has
 * other rows (see `DataTable`). Its values here are not read: its cells read them from a store, so
 * that the table need not render again when they change, as they do whenever a test is hidden or
 * shown.
 */
const PINNED: GeomeanRow[] = [
  { test: null, a: null, b: null, delta: null, deltaPct: null, ratio: null, status: 'na' },
]

/** A cell of the geomean row, as `column` shows the values `store` holds. */
function GeomeanCell({ store, column }: { store: ValueStore<Values>; column: CompareColumn }) {
  const values = useStoreValue(store, (value) => value)
  return column.cell({ ...values, test: null })
}

const testOf = (row: Row) => row.test ?? ''

/**
 * Show only `test` among the tests the table shows, or, when it is the only one shown already,
 * show them all (CP2 "Hidden tests"). The tests the table does not show are left as they are.
 */
function isolate(rows: RowSelection, test: string, shown: readonly string[]) {
  const hidden = rows.selected()
  const alone = !hidden.has(test) && shown.every((other) => other === test || hidden.has(other))
  const next = new Set(hidden)
  for (const other of shown) {
    if (alone || other === test) next.delete(other)
    else next.add(other)
  }
  rows.replace(next)
}

interface Props {
  /** The rows the table shows, in the order they are sorted in. */
  rows: ComparisonRow[]
  /** Their tests, in the same order. */
  tests: string[]
  /** The selection of the hidden tests. */
  hidden: RowSelection
  /** How many rows are shown, that is not hidden, and the summary message they make. */
  summary: string
  /** Why the URL does not hold the hidden tests, when it does not (CP7). */
  notInUrl?: string
  geomean: Values
  /** What the table says when it has no row, and why. */
  empty: string
  /** Whether the rows are about to be replaced, by those of another classification of the noise. */
  busy: boolean
  sort: TableSort
  onSort(sort: TableSort): void
  /** The compared rows as CSV, or null when there is none to copy (CP2 "Copy as CSV"). */
  csv: (() => string) | null
}

/**
 * The comparison table (CP2): a row per test, with a checkbox hiding it, each side's value, how
 * they differ and the test's status, sorted by any column, with the geomean summary row first.
 * Rows are hidden and shown with their checkboxes, a click on the row, a range at a time with Shift
 * (AR10), or all but one with a double-click.
 */
export function CompareTable({
  rows,
  tests,
  hidden,
  summary,
  notInUrl,
  geomean,
  empty,
  busy,
  sort,
  onSort,
  csv,
}: Props) {
  const [store] = useState(() => new ValueStore(geomean))
  useLayoutEffect(() => store.set(geomean), [geomean, store])

  const columns = useMemo(
    (): Column<Row>[] => [
      {
        id: 'show',
        header: <SelectAllBox rows={hidden} shown={tests} label="Show all tests shown" />,
        cell: (row) =>
          row.test === null ? null : (
            <SelectBox rows={hidden} rowKey={row.test} label={`Show ${row.test}`} />
          ),
      },
      ...COLUMNS.map((column): Column<Row> => ({
        id: column.id,
        header: column.header,
        looks: column.looks,
        cell: (row) =>
          row.test === null ? <GeomeanCell store={store} column={column} /> : column.cell(row),
        sortKey: (row) => (row.test === null ? null : column.sortKey(row)),
      })),
    ],
    [hidden, tests, store],
  )

  const rowProps = useCallback(
    (row: Row) => {
      const { test } = row
      if (test === null) return {}
      return {
        className: styles.testRow,
        onClick: (event: MouseEvent) => {
          // The checkbox and the links handle their own clicks.
          if ((event.target as Element).closest('input, a') !== null) return
          hidden.click(test, event.shiftKey)
        },
        onDoubleClick: (event: MouseEvent) => {
          if ((event.target as Element).closest('input, a') === null) isolate(hidden, test, tests)
        },
        // Shift selects a range of rows, and a double-click isolates one, rather than text.
        onMouseDown: (event: MouseEvent) => {
          if (event.shiftKey || event.detail > 1) event.preventDefault()
        },
      }
    },
    [hidden, tests],
  )

  return (
    <>
      <div className={styles.countRow}>
        <p className={styles.count} role="status">
          {summary}
          {notInUrl !== undefined && (
            <span title={notInUrl}> (too many hidden to reflect in the URL)</span>
          )}
        </p>
        {csv !== null && <CopyButton text={csv}>Copy as CSV</CopyButton>}
      </div>
      <DataTable
        label="Comparison"
        columns={columns}
        rows={rows}
        rowKey={testOf}
        rowProps={rowProps}
        pinned={PINNED}
        empty={empty}
        busy={busy}
        sort={sort}
        onSort={onSort}
        presorted
      />
    </>
  )
}
