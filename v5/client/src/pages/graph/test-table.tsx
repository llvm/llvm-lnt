import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from 'react'
import { VisuallyHidden } from 'react-aria-components'
import { DataTable, type Column } from '../../components/data-table'
import { Loading } from '../../components/feedback'
import type { RangeSelection, RowSelection } from '../../components/range-selection'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import styles from './graph.module.css'

interface Props {
  /** Every test listed, filtered or not. */
  all: string[]
  /** The tests the filter keeps, in order: the table's rows. */
  shown: string[]
  /** Whether the filter is set. */
  filtered: boolean
  selection: RangeSelection
  /** Each test's colour on the chart. */
  colors: ReadonlyMap<string, string>
  /** The selected tests whose data is still loading. */
  loading: ReadonlySet<string>
  /** Whether the tests are still being listed. */
  listing: boolean
  /** What the table says while no test is listed, and why. */
  empty: string
}

/**
 * Which of a list of tests a cell's row is among, for cells to render again on their own when their
 * row joins or leaves it, rather than with the whole table (as `SelectBox` does for the selection).
 */
class TestSet {
  private tests: ReadonlySet<string> = new Set()
  private readonly listeners = new Set<() => void>()

  has = (test: string) => this.tests.has(test)

  set(tests: ReadonlySet<string>) {
    this.tests = tests
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/**
 * The tests to plot (GR6, GR7): every test listed that the filter keeps, by name, each selected or
 * not with its checkbox or a click on its row, a range at a time with Shift (AR10). A double-click
 * isolates a test, or selects every test shown again once it is the only one selected. A selected
 * test shows its colour on the chart, and whether its data is still loading. The table is the
 * chart's legend, with the machines' chips.
 */
export function TestTable({
  all,
  shown,
  filtered,
  selection,
  colors,
  loading,
  listing,
  empty,
}: Props) {
  const { rows, selected } = selection
  const [loadingStore] = useState(() => new TestSet())
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
        cell: (test) => <Swatch rows={rows} test={test} color={colors.get(test)} />,
      },
      {
        id: 'test',
        header: 'Test',
        cell: (test) => (
          <>
            {test}
            <LoadingMark store={loadingStore} test={test} />
          </>
        ),
      },
    ],
    [rows, shown, colors, loadingStore],
  )

  const rowProps = useCallback(
    (test: string) => ({
      className: styles.testRow,
      onClick: (event: MouseEvent) => {
        // The checkbox handles its own clicks.
        if ((event.target as HTMLElement).closest('input') !== null) return
        rows.click(test, event.shiftKey)
      },
      onDoubleClick: () => isolate(rows, test, shown),
      // Shift selects a range of rows, not their text.
      onMouseDown: (event: MouseEvent) => {
        if (event.shiftKey) event.preventDefault()
      },
    }),
    [rows, shown],
  )

  if (listing) return <Loading label="Loading tests..." />
  if (all.length === 0) return <p className={styles.note}>{empty}</p>

  const count = shown.filter((test) => selected.has(test)).length
  return (
    <>
      <p className={styles.count} role="status">
        {filtered
          ? `${count} of ${shown.length} matching tests selected (${all.length} total)`
          : `${count} of ${all.length} tests selected`}
        {loading.size > 0 && ', loading...'}
      </p>
      <DataTable
        label="Tests"
        columns={columns}
        rows={shown}
        rowKey={nameOf}
        rowProps={rowProps}
        empty="No tests match the filter."
      />
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
function Swatch({ rows, test, color }: { rows: RowSelection; test: string; color?: string }) {
  const selected = useSyncExternalStore(rows.subscribe, () => rows.selected().has(test))
  if (!selected || color === undefined) return null
  return <span className={styles.swatch} style={{ background: color }} aria-hidden="true" />
}

/** Whether a selected test's data is still loading (GR7). */
function LoadingMark({ store, test }: { store: TestSet; test: string }) {
  const loading = useSyncExternalStore(store.subscribe, () => store.has(test))
  return loading ? <span className={styles.loadingMark}> (loading...)</span> : null
}
