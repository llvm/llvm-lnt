import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { colorOfName } from '../../chart-colors'
import { DataTable, type Column } from '../../components/data-table'
import { Loading } from '../../components/feedback'
import type { RangeSelection, RowSelection } from '../../components/range-selection'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import { useStoreValue, ValueStore } from '../../value-store'
import styles from './graph.module.css'

interface Props {
  /** Every test listed, filtered or not. */
  all: string[]
  /** The tests the filter keeps, in order: the table's rows. */
  shown: string[]
  /** Whether the filter is set. */
  filtered: boolean
  selection: RangeSelection
  /** The selected tests whose data is still loading. */
  loading: ReadonlySet<string>
  /** Why the URL does not reflect the selection, if it does not, which the table warns of. */
  notInUrl?: string
  /** Whether some machine's tests are still being listed. */
  listing: boolean
  /** What the table says while no test is listed, and why. */
  empty: string
  /** Where the table says which test's row is hovered, for the chart to emphasize it (GR7). */
  emphasis: ValueStore<string | null>
  /** The test whose line is hovered on the chart, whose row the table highlights (GR7). */
  hovered: ValueStore<string | null>
}

/**
 * The tests to plot (GR6, GR7): every test listed that the filter keeps, by name, each selected or
 * not with its checkbox or a click on its row, a range at a time with Shift (AR10). A double-click
 * isolates a test, or selects every test shown again once it is the only one selected. A selected
 * test shows its colour on the chart, and whether its data is still loading. The table is the
 * chart's legend, with the machines' chips: hovering a row emphasizes the test's lines on the
 * chart, and hovering one of them highlights its row (GR7).
 */
export function TestTable({
  all,
  shown,
  filtered,
  selection,
  loading,
  notInUrl,
  listing,
  empty,
  emphasis,
  hovered,
}: Props) {
  const { rows, selected } = selection
  // Which tests are loading, for each row to render again on its own when its test starts or stops
  // loading, rather than with the whole table (as `SelectBox` does for the selection).
  const [loadingStore] = useState(() => new ValueStore<ReadonlySet<string>>(new Set()))
  useLayoutEffect(() => loadingStore.set(loading), [loading, loadingStore])

  const columns = useMemo(
    (): Column<string>[] => [
      {
        id: 'select',
        header: <SelectAllBox rows={rows} shown={shown} label="Select all tests shown" />,
        cell: (test) => <SelectBox rows={rows} rowKey={test} label={test} />,
      },
      {
        id: 'color',
        header: <VisuallyHidden>Color</VisuallyHidden>,
        cell: (test) => <Swatch rows={rows} test={test} />,
      },
      {
        id: 'test',
        header: 'Test',
        cell: (test) => (
          <HoverMark store={hovered} test={test}>
            {test}
            <LoadingMark store={loadingStore} test={test} />
          </HoverMark>
        ),
      },
    ],
    [rows, shown, loadingStore, hovered],
  )

  const rowProps = useCallback(
    (test: string) => ({
      className: styles.testRow,
      onClick: (event: MouseEvent) => {
        // The checkbox handles its own clicks.
        if ((event.target as HTMLElement).closest('input') !== null) return
        rows.click(test, event.shiftKey)
      },
      onDoubleClick: (event: MouseEvent) => {
        if ((event.target as HTMLElement).closest('input') === null) isolate(rows, test, shown)
      },
      // Shift selects a range of rows, and a double-click isolates one, rather than text.
      onMouseDown: (event: MouseEvent) => {
        if (event.shiftKey || event.detail > 1) event.preventDefault()
      },
      onMouseEnter: () => emphasis.set(test),
    }),
    [rows, shown, emphasis],
  )

  // The tests listed so far stay shown while another machine's are listed (AR7).
  if (all.length === 0) {
    return listing ? <Loading label="Loading tests..." /> : <p className={styles.note}>{empty}</p>
  }

  const count = shown.filter((test) => selected.has(test)).length
  return (
    <>
      {listing && <Loading label="Loading tests..." />}
      <p className={styles.count} role="status">
        {filtered
          ? `${count} of ${shown.length} matching tests selected (${all.length} total)`
          : `${count} of ${all.length} tests selected`}
        {notInUrl !== undefined && <span title={notInUrl}> (too many to reflect in the URL)</span>}
        {loading.size > 0 && ', loading...'}
      </p>
      {/* Leaving a row for another emphasizes the other at once, without drawing none between. */}
      <div onMouseLeave={() => emphasis.set(null)}>
        <DataTable
          label="Tests"
          columns={columns}
          rows={shown}
          rowKey={nameOf}
          rowProps={rowProps}
          empty="No tests match the filter."
        />
      </div>
    </>
  )
}

const nameOf = (test: string) => test

/**
 * Select `test` alone, or, when it is the only test selected, every test shown again, as long as
 * that is within the limit (GR7).
 */
function isolate(rows: RowSelection, test: string, shown: string[]) {
  const selected = rows.selected()
  if (selected.size === 1 && selected.has(test)) rows.replace(shown)
  else rows.replace([test])
}

/** The colour of a selected test's traces (GR6), as a swatch, which has no shape of a machine's. */
function Swatch({ rows, test }: { rows: RowSelection; test: string }) {
  const selected = useSyncExternalStore(rows.subscribe, () => rows.selected().has(test))
  if (!selected) return null
  return (
    <span className={styles.swatch} style={{ background: colorOfName(test) }} aria-hidden="true" />
  )
}

interface HoverMarkProps {
  store: ValueStore<string | null>
  test: string
  children: ReactNode
}

/** A test's name, marked while its line is hovered on the chart, which highlights its row (GR7). */
function HoverMark({ store, test, children }: HoverMarkProps) {
  const hovered = useStoreValue(store, (shown) => shown === test)
  return <span className={hovered ? styles.hovered : undefined}>{children}</span>
}

/** Whether a selected test's data is still loading (GR7). */
function LoadingMark({ store, test }: { store: ValueStore<ReadonlySet<string>>; test: string }) {
  const loading = useStoreValue(store, (tests) => tests.has(test))
  return loading ? <span className={styles.loadingMark}> (loading...)</span> : null
}
