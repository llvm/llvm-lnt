import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { Link } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { CopyButton } from '../../components/copy-button'
import { DataTable, type Column } from '../../components/data-table'
import type { RowSelection } from '../../components/range-selection'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import type { TableSort } from '../../components/table-sort'
import { useStoreValue, ValueStore } from '../../value-store'
import type { CompareColumn, GeomeanRow, Row } from './columns'
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

/** A test's name, marked while its bar is hovered on the chart, which highlights its row (CP5). */
function HoverMark({ store, test }: { store: ValueStore<string | null>; test: string }) {
  const hovered = useStoreValue(store, (shown) => shown === test)
  return <span className={hovered ? styles.hovered : undefined}>{test}</span>
}

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

/** What the table shows, computed from the comparison (see `useComparisonTable`). */
export interface TableView {
  /** The rows the table shows, in the order they are sorted in. */
  rows: ComparisonRow[]
  /** The columns after the checkbox column, the optional statistics included. */
  columns: CompareColumn[]
  /** Their tests, in the same order. */
  tests: string[]
  /** The selection of the hidden tests. */
  hidden: RowSelection
  /** The summary message: how many rows are shown, that is not hidden, of how many. */
  summary: string
  /** Why the URL does not hold the hidden tests, when it does not (CP7). */
  notInUrl?: string
  geomean: Values
  /** What the table says when it has no row, and why. */
  empty: string
  /** The Profiles page of each test that has a profile, by test. */
  links: ReadonlyMap<string, string>
  /** Whether any compared test has a profile, which the Profile column is shown for. */
  profiled: boolean
  sort: TableSort
  onSort(sort: TableSort): void
  /** The compared rows as CSV, or null when there is none to copy (CP2 "Copy as CSV"). */
  csv: (() => string) | null
}

interface Props extends TableView {
  /** The Columns menu, on the summary message's row. */
  menu: ReactNode
  /** The test whose bar is hovered on the chart, whose row the table highlights (CP5). */
  hovered: ValueStore<string | null>
  /** Where the table says which test's row is hovered, for the chart to outline its bar. */
  emphasis: ValueStore<string | null>
}

/**
 * The comparison table (CP2): a row per test, with a checkbox hiding it, each side's value, how
 * they differ, the test's status and a link to its profiles, if it has any, sorted by any column
 * but the last, with the geomean summary row first.
 * Rows are hidden and shown with their checkboxes, a click on the row, a range at a time with Shift
 * (AR10), or all but one with a double-click.
 */
export function CompareTable({
  rows,
  columns: shownColumns,
  menu,
  tests,
  hidden,
  summary,
  notInUrl,
  geomean,
  empty,
  sort,
  onSort,
  csv,
  hovered,
  emphasis,
  links,
  profiled,
}: Props) {
  const [store] = useState(() => new ValueStore(geomean))
  useLayoutEffect(() => store.set(geomean), [geomean, store])

  const columns = useMemo(() => {
    const all: Column<Row>[] = [
      {
        id: 'show',
        header: <SelectAllBox rows={hidden} shown={tests} label="Show all tests shown" />,
        className: styles.showColumn,
        cell: (row) =>
          row.test === null ? null : (
            <SelectBox rows={hidden} rowKey={row.test} label={`Show ${row.test}`} />
          ),
      },
      ...shownColumns.map((column): Column<Row> => ({
        id: column.id,
        header: column.header,
        looks: column.looks,
        className: column.id === 'test' ? styles.testColumn : undefined,
        cell: (row) =>
          row.test === null ? (
            <GeomeanCell store={store} column={column} />
          ) : column.id === 'test' ? (
            <HoverMark store={hovered} test={row.test} />
          ) : (
            column.cell(row)
          ),
        // Only says that the column can be sorted by: the rows come sorted (see `sortComparison`).
        sortKey: () => null,
      })),
    ]
    if (profiled) {
      all.push({
        id: 'profile',
        header: <VisuallyHidden>Profile</VisuallyHidden>,
        looks: ['nowrap'],
        cell: (row) => {
          const to = row.test === null ? undefined : links.get(row.test)
          return to === undefined ? null : <Link to={to}>Profile</Link>
        },
      })
    }
    return all
  }, [hidden, tests, store, shownColumns, hovered, profiled, links])

  const rowProps = useCallback(
    (row: Row) => {
      const { test } = row
      if (test === null) return { onMouseEnter: () => emphasis.set(null) }
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
        onMouseEnter: () => emphasis.set(test),
      }
    },
    [hidden, tests, emphasis],
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
        <div className={styles.tableActions}>
          {menu}
          {csv !== null && <CopyButton text={csv}>Copy as CSV</CopyButton>}
        </div>
      </div>
      {/*
        Leaving a row for another outlines the other's bar at once, with no gap between. Leaving
        the rows for the header, or for the box's scrollbar, outlines none.
      */}
      <div
        className={styles.tableBox}
        onMouseLeave={() => emphasis.set(null)}
        onMouseOver={(event) => {
          if ((event.target as Element).closest('tbody') === null) emphasis.set(null)
        }}
      >
        <DataTable
          label="Comparison"
          columns={columns}
          rows={rows}
          rowKey={testOf}
          rowProps={rowProps}
          pinned={PINNED}
          empty={empty}
          sort={sort}
          onSort={onSort}
          presorted
        />
      </div>
    </>
  )
}
