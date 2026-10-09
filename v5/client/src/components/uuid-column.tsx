import { Link } from 'react-router'
import { shortUuid } from '../format'
import type { Column } from './data-table'

/**
 * A table's column of an entity's UUID, shortened as AR2 says, in full on hover, and linking to the
 * entity's page: the same in every table that has one.
 */
export function uuidColumn<Row extends { uuid: string }>(
  id: string,
  header: string,
  pathOf: (uuid: string) => string,
): Column<Row> {
  return {
    id,
    header,
    looks: ['mono', 'nowrap'],
    cell: (row) => (
      <Link to={pathOf(row.uuid)} title={row.uuid}>
        {shortUuid(row.uuid)}
      </Link>
    ),
  }
}
