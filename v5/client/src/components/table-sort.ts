import { compareStrings } from '../format'
import type { Param } from '../url-state'

/** The values of `aria-sort` for a sorted column, which name the directions. */
export type SortDirection = 'ascending' | 'descending'

/** Which column a table's rows are sorted by, and in which direction. */
export interface TableSort {
  /** The `id` of the column. */
  column: string
  direction: SortDirection
}

/**
 * What a row is sorted by in a column: numbers numerically, strings as `compareStrings` orders
 * them. Null is for a row with no value to sort by, which sorts after every row that has one, in
 * both directions.
 */
export type SortKey = number | string | null

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return compareStrings(String(a), String(b))
}

/**
 * `rows`, sorted by `sortKey` in `direction`. The sort is stable, so that rows with the same key
 * keep the order they came in, whichever the direction.
 */
export function sortRows<Row>(
  rows: readonly Row[],
  sortKey: (row: Row) => SortKey,
  direction: SortDirection,
): Row[] {
  const sign = direction === 'ascending' ? 1 : -1
  return rows
    .map((row) => ({ row, key: sortKey(row) }))
    .sort((a, b) => {
      if (a.key === null || b.key === null) return Number(a.key === null) - Number(b.key === null)
      return sign * compareKeys(a.key, b.key)
    })
    .map(({ row }) => row)
}

/**
 * The sort a click on the header of `column` asks for: the other direction if the rows are already
 * sorted by it, and ascending otherwise.
 */
export function nextSort(current: TableSort, column: string): TableSort {
  if (current.column !== column) return { column, direction: 'ascending' }
  return { column, direction: current.direction === 'ascending' ? 'descending' : 'ascending' }
}

/**
 * A sort kept in the URL (AR2 "State"): the column's `id`, prefixed with `-` for descending order
 * (`sort=-created_at`). A column that is not among `columns` is unusable.
 */
export function sortParam(columns: readonly string[], defaultSort: TableSort): Param<TableSort> {
  return {
    default: defaultSort,
    parse: (values) => {
      if (values.length !== 1) return undefined
      const descending = values[0].startsWith('-')
      const column = descending ? values[0].slice(1) : values[0]
      if (!columns.includes(column)) return undefined
      return { column, direction: descending ? 'descending' : 'ascending' }
    },
    serialize: ({ column, direction }) => [direction === 'descending' ? `-${column}` : column],
  }
}
