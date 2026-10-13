import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DataTable, type Column } from './data-table'
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
})
