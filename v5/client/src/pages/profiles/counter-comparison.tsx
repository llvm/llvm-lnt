import { useMemo } from 'react'
import clsx from 'clsx'
import { DataTable, type Column } from '../../components/data-table'
import { formatNumber, formatPercent, NA } from '../../format'
import { comparedValue, difference, differenceDirection, type ComparedValue } from './counters'
import { noCountersText, type Counter } from './use-counter'
import type { SideFunctions } from './use-functions'
import type { ProfileSide } from './use-side'
import styles from './profiles.module.css'

/** A row of the counter comparison: a top-level counter, or the functions shown under one. */
interface Row {
  kind: 'counter' | 'function'
  /** The counter's name. */
  counter: string
  /** Each side's value, in the order of the sides. */
  values: ComparedValue[]
}

function formatValue(value: ComparedValue): string {
  if (value === undefined) return ''
  return value === null ? NA : formatNumber(value)
}

const COUNTER: Column<Row> = {
  id: 'counter',
  header: 'Counter',
  cell: (row) => (row.kind === 'function' ? `Function ${row.counter}` : row.counter),
}

function valueColumn(id: string, header: string, side: number): Column<Row> {
  return { id, header, looks: ['numeric'], cell: (row) => formatValue(row.values[side]) }
}

const DIFFERENCE: Column<Row> = {
  id: 'difference',
  header: 'Difference',
  looks: ['numeric', 'nowrap'],
  cell: (row) => <Difference value={difference(row.values[0], row.values[1])} />,
}

const TWO_SIDED = [COUNTER, valueColumn('a', 'A', 0), valueColumn('b', 'B', 1), DIFFERENCE]
const ONE_SIDED = [COUNTER, valueColumn('value', 'Value', 0)]

const rowKey = (row: Row) => `${row.kind}/${row.counter}`
const rowProps = (row: Row) =>
  row.kind === 'function' ? { className: styles.functionComparison } : {}

/**
 * A Difference (PF3), green when shown as a decrease and red when shown as an increase, with a bar
 * of that color as long as the Difference, full from 100% up.
 */
function Difference({ value }: { value: ComparedValue }) {
  if (value === undefined) return null
  const text = value === null ? NA : formatPercent(value, { signed: true })
  const direction = differenceDirection(text)
  return (
    <span className={clsx(styles.difference, direction && styles[direction])}>
      <span className={styles.differenceText}>{text}</span>
      {/* Present in every row, so that the texts line up. */}
      <span className={styles.differenceTrack} aria-hidden="true">
        {direction && value !== null && (
          <span
            className={styles.differenceBar}
            style={{ width: `${Math.min(Math.abs(value), 100)}%` }}
          />
        )}
      </span>
    </span>
  )
}

/**
 * The value of `counter` for the function a side shows (PF3): empty until the function is known,
 * and N/A when its profile lists no functions or the function does not have the counter.
 */
function useFunctionValue(
  { name, functions }: SideFunctions,
  counter: string | undefined,
): ComparedValue {
  const list = functions.data
  // Memoized, because a profile can list thousands of functions.
  const fn = useMemo(
    () => (name ? list?.find((entry) => entry.name === name) : undefined),
    [list, name],
  )
  if (name === undefined || counter === undefined) return undefined
  if (name === null) return null
  // Empty until the functions are listed. A side only holds a function its profile lists, so the
  // function is among them once they are.
  return comparedValue(fn?.counters, counter)
}

interface Props {
  /** The sides that show a profile, in order. */
  sides: readonly ProfileSide[]
  functions: { a: SideFunctions; b: SideFunctions }
  counter: Counter
}

/**
 * The top-level counters of the profiles shown (PF3). With two sides, a table compares them, and
 * its last row compares the functions shown under the counter shown. With one side, a table lists
 * them. The table's columns depend only on which sides show a profile: the column of a side whose
 * counters are not loaded is empty.
 */
export function CounterComparison({ sides, functions, counter }: Props) {
  const functionValues = [
    useFunctionValue(functions.a, counter.listed),
    useFunctionValue(functions.b, counter.listed),
  ]
  const loaded = sides.map(({ status }) =>
    status.kind === 'shown' ? status.profile.counters : undefined,
  )
  const both = sides.length === 2
  const rows: Row[] = counter.offered.map((name) => ({
    kind: 'counter',
    counter: name,
    values: loaded.map((counters) => comparedValue(counters, name)),
  }))
  if (both && counter.listed !== undefined) {
    rows.push({ kind: 'function', counter: counter.listed, values: functionValues })
  }
  return (
    <div className={styles.comparison}>
      <DataTable
        label="Counter comparison"
        columns={both ? TWO_SIDED : ONE_SIDED}
        rows={rows}
        rowKey={rowKey}
        rowProps={rowProps}
        empty={counter.none ? 'No counters' : noCountersText(counter)}
      />
    </div>
  )
}
