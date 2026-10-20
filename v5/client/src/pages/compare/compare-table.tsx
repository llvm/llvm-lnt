import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import { VisuallyHidden } from 'react-aria-components'
import { CopyButton } from '../../components/copy-button'
import {
  DataTable,
  type Column,
  type RowAttributes,
  type RowClasses,
} from '../../components/data-table'
import { isolateRow, type RowSelection } from '../../components/range-selection'
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

/**
 * The header's checkbox, over the tests the table shows, which it reads from `shownTests` so that
 * the columns need not change with them: a change to the columns renders every row again.
 */
function ShowAllBox({
  rows,
  shownTests,
}: {
  rows: RowSelection
  shownTests: ValueStore<string[]>
}) {
  const tests = useStoreValue(shownTests, (value) => value)
  return <SelectAllBox rows={rows} shown={tests} label="Show all tests shown" />
}

/** A cell of the geomean row, as `column` shows the values `store` holds. */
function GeomeanCell({ store, column }: { store: ValueStore<Values>; column: CompareColumn }) {
  const values = useStoreValue(store, (value) => value)
  return column.cell({ ...values, test: null })
}

const testOf = (row: Row) => row.test ?? ''

/**
 * A test's row, which a click hides or shows, and which says which test it is, for the table's
 * handlers to tell (see `CompareTable`).
 */
const rowProps = (row: Row): RowAttributes =>
  row.test === null ? {} : { className: styles.testRow, 'data-test': row.test }

/** The test of the row `target` is in, if it is a test's row. */
function rowTestOf(target: EventTarget): string | null {
  return (target as Element).closest('tr[data-test]')?.getAttribute('data-test') ?? null
}

/** The test of the row clicked, unless the click is on a checkbox or a link, which handle it. */
function clickedTest(target: EventTarget): string | null {
  return (target as Element).closest('input, a') === null ? rowTestOf(target) : null
}

/**
 * Whether `box`'s content is wider than it, which it then scrolls horizontally (CP2 "Width"), from
 * the sizes of the box and of what it holds -- the table, which stays the same element -- which the
 * columns shown change. Measured before the page is painted, and again on every resize of either.
 */
function useOverflowing(box: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    const measure = () => setOverflowing(element.scrollWidth > element.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => observer.disconnect()
  }, [box])
  return overflowing
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
  /** The Profiles page of each test that has a profile on both sides, by test. */
  links: ReadonlyMap<string, string>
  /** Whether any test of the comparison has such a link, which the Profile column is shown for. */
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
 * they differ, the test's status and a link to its profiles, if both sides have one, sorted by any
 * column but the last, with the geomean summary row first.
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
  const [shownTests] = useState(() => new ValueStore(tests))
  useLayoutEffect(() => shownTests.set(tests), [tests, shownTests])

  const box = useRef<HTMLDivElement>(null)
  const overflowing = useOverflowing(box)

  // A hidden test's row is greyed out, and the row of the test whose bar is hovered on the chart
  // highlighted (CP5), rendering only the rows that change.
  const rowClasses = useMemo(
    (): RowClasses<Row> => ({
      subscribe: (listener) => {
        const unsubscribe = [hidden.subscribe(listener), hovered.subscribe(listener)]
        return () => unsubscribe.forEach((call) => call())
      },
      of: ({ test }) =>
        test === null
          ? undefined
          : clsx(
              hidden.selected().has(test) && styles.hiddenRow,
              hovered.get() === test && styles.hoveredRow,
            ),
    }),
    [hidden, hovered],
  )

  const columns = useMemo(() => {
    const all: Column<Row>[] = [
      {
        id: 'show',
        header: <ShowAllBox rows={hidden} shownTests={shownTests} />,
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
          row.test === null ? <GeomeanCell store={store} column={column} /> : column.cell(row),
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
  }, [hidden, shownTests, store, shownColumns, profiled, links])

  // The rows' handlers, on the box holding the table rather than on each of thousands of rows.
  const onClick = (event: MouseEvent) => {
    const test = clickedTest(event.target)
    if (test !== null) hidden.click(test, event.shiftKey)
  }
  const onDoubleClick = (event: MouseEvent) => {
    // Shows only `test` among the rows, or all of them again (CP2 "Hidden tests").
    const test = clickedTest(event.target)
    if (test !== null) {
      hidden.replace(isolateRow(hidden.selected(), shownTests.get(), test, hidden.inverted()))
    }
  }
  // Shift selects a range of rows, and a double-click isolates one, rather than text.
  const onMouseDown = (event: MouseEvent) => {
    if (rowTestOf(event.target) !== null && (event.shiftKey || event.detail > 1)) {
      event.preventDefault()
    }
  }

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
        the rows for the geomean's, the header, or the box's scrollbar, outlines none.
        The checkboxes and the tests' names stick only while the box scrolls: sticky cells by the
        thousand are slow to scroll past, and are of no use while everything is in view.
      */}
      <div
        ref={box}
        className={clsx(styles.tableBox, overflowing && styles.overflowing)}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onMouseDown={onMouseDown}
        onMouseLeave={() => emphasis.set(null)}
        onMouseOver={(event) => emphasis.set(rowTestOf(event.target))}
      >
        <DataTable
          label="Comparison"
          columns={columns}
          rows={rows}
          rowKey={testOf}
          rowProps={rowProps}
          rowClasses={rowClasses}
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
