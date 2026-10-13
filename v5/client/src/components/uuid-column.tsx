import type { Column } from './data-table'
import { UuidLink } from './uuid-link'

/**
 * A table's column of an entity's UUID, shortened as AR6 says, in full on hover, and linking to the
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
    cell: (row) => <UuidLink uuid={row.uuid} to={pathOf(row.uuid)} />,
  }
}
