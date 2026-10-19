import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ValueStore } from '../value-store'
import { DataTable, type Column, type RowClasses } from './data-table'
import type { TableSort } from './table-sort'

const COLUMNS: Column<string>[] = [
  { id: 'name', header: 'Name', cell: (row) => row, sortKey: (row) => row },
]
const BY_NAME: TableSort = { column: 'name', direction: 'ascending' }

/** The text of the table's body rows, in order. */
const shown = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent)

function Table(props: {
  presorted?: boolean
  onSort?: (sort: TableSort) => void
  pinned?: string[]
}) {
  return (
    <DataTable
      label="Names"
      columns={COLUMNS}
      rows={['b', 'c', 'a']}
      rowKey={(row) => row}
      empty="None."
      sort={BY_NAME}
      onSort={props.onSort ?? (() => {})}
      presorted={props.presorted}
      pinned={props.pinned}
    />
  )
}

describe('DataTable', () => {
  it('sorts its rows, after the pinned ones', () => {
    render(<Table pinned={['z']} />)
    expect(shown()).toEqual(['z', 'a', 'b', 'c'])
  })

  it('shows presorted rows as they come, and still asks for another sort from a header', async () => {
    const onSort = vi.fn()
    render(<Table presorted onSort={onSort} />)
    expect(shown()).toEqual(['b', 'c', 'a'])

    await userEvent.setup().click(screen.getByRole('button', { name: /Name/ }))

    expect(onSort).toHaveBeenCalledWith({ column: 'name', direction: 'descending' })
  })

  it('renders again only the rows whose classes change, and no row when the rows are reordered', () => {
    const cell = vi.fn((row: string) => row)
    const columns: Column<string>[] = [{ id: 'name', header: 'Name', cell }]
    const marked = new ValueStore<string | null>(null)
    const rowClasses: RowClasses<string> = {
      subscribe: marked.subscribe,
      of: (row) => (row === marked.get() ? 'marked' : undefined),
    }
    const table = (rows: string[]) => (
      <DataTable
        label="Names"
        columns={columns}
        rows={rows}
        rowKey={(row) => row}
        rowClasses={rowClasses}
        empty="None."
      />
    )
    const { rerender } = render(table(['a', 'b', 'c']))
    cell.mockClear()

    rerender(table(['c', 'b', 'a']))
    expect(shown()).toEqual(['c', 'b', 'a'])
    expect(cell).not.toHaveBeenCalled()

    act(() => marked.set('b'))
    expect(screen.getByRole('row', { name: 'b' })).toHaveClass('marked')
    expect(screen.getByRole('row', { name: 'a' })).not.toHaveClass('marked')
    expect(cell.mock.calls).toEqual([['b']])
  })

  it('renders again only the row whose confirmation starts or ends', () => {
    const cell = vi.fn((row: string) => row)
    const columns: Column<string>[] = [{ id: 'name', header: 'Name', cell }]
    const table = (confirming: string | null) => (
      <DataTable
        label="Names"
        columns={columns}
        rows={['a', 'b', 'c']}
        rowKey={(row) => row}
        // Inline, as callers pass it.
        confirming={(row) => row === confirming}
        empty="None."
      />
    )
    const { rerender } = render(table(null))
    cell.mockClear()

    rerender(table('b'))
    expect(cell.mock.calls).toEqual([['b']])
  })
})
