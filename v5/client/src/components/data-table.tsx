import type { HTMLAttributes, ReactNode, Ref } from 'react'
import clsx from 'clsx'
import styles from './data-table.module.css'

/**
 * A look a column's cells can take: `numeric` right-aligns them, header included, with digits of
 * the same width (a count, say), `nowrap` keeps them on one line, and `mono` sets them in a
 * fixed-width font (an identifier), unlike the header, which names it in words.
 */
export type CellLook = 'numeric' | 'nowrap' | 'mono'

export interface Column<Row> {
  /** Identifies the column among the table's, whichever of them are shown. */
  id: string
  header: ReactNode
  cell: (row: Row) => ReactNode
  /** How the column's cells look. */
  looks?: readonly CellLook[]
  /** A class of the page's own for the column's cells, header included. */
  className?: string
}

/** The classes of a cell of `column`: one of its body cells, or its header. */
function cellClass<Row>({ looks = [], className }: Column<Row>, header: boolean): string {
  const shown = header ? looks.filter((look) => look === 'numeric') : looks
  return clsx(
    header ? styles.header : styles.cell,
    shown.map((look) => styles[look]),
    className,
  )
}

interface Props<Row> {
  /** The table's accessible name. */
  label: string
  columns: Column<Row>[]
  rows: Row[]
  rowKey: (row: Row) => string
  /** Attributes of a row's `<tr>`: a click handler, or a class to grey it out, say. */
  rowProps?: (row: Row) => HTMLAttributes<HTMLTableRowElement>
  /** What to say, in place of the rows, when there are none. */
  empty: ReactNode
  /** The rows shown are about to be replaced, by another page or another search's. */
  busy?: boolean
  /** Makes the table focusable from script: where focus goes once a row it held is deleted. */
  ref?: Ref<HTMLTableElement>
}

/** A table of entities, styled the same on every page (AR2 "Design consistency"). */
export function DataTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  rowProps,
  empty,
  busy = false,
  ref,
}: Props<Row>) {
  return (
    <table
      ref={ref}
      tabIndex={ref ? -1 : undefined}
      className={styles.table}
      aria-label={label}
      aria-busy={busy}
    >
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.id} scope="col" className={cellClass(column, true)}>
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td colSpan={columns.length} className={clsx(styles.cell, styles.empty)}>
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((row) => {
            const props = rowProps?.(row)
            return (
              <tr key={rowKey(row)} {...props} className={clsx(styles.row, props?.className)}>
                {columns.map((column) => (
                  <td key={column.id} className={cellClass(column, false)}>
                    {column.cell(row)}
                  </td>
                ))}
              </tr>
            )
          })
        )}
      </tbody>
    </table>
  )
}
