import { useMemo } from 'react'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { DataTable, type Column } from '../../components/data-table'
import { StateBadge } from '../../components/regression-state'
import { uuidColumn } from '../../components/uuid-column'
import { regressionTitle, truncate } from '../../format'
import { regressionPath } from '../../paths'

type Regression = Schemas['Regression']

/** How long a title may be in this table before it is cut short (DT1). */
const TITLE_LENGTH = 50

interface Props {
  suite: string
  /** The table's accessible name. */
  label: string
  regressions: Regression[]
  empty: string
  /** The rows shown are about to be replaced by another page's. */
  busy?: boolean
}

const rowKey = (regression: Regression) => regression.uuid

/**
 * The regressions related to the entity of a detail page: each one's shortened UUID, which tells
 * those without a title apart, and its title, both linked to its page, the title cut short and
 * whole on hover, its state, and how many tests its indicators name (DT1).
 */
export function RegressionsTable({ suite, label, regressions, empty, busy }: Props) {
  const columns = useMemo(() => regressionColumns(suite), [suite])
  return (
    <DataTable
      label={label}
      columns={columns}
      rows={regressions}
      rowKey={rowKey}
      empty={empty}
      busy={busy}
    />
  )
}

function regressionColumns(suite: string): Column<Regression>[] {
  return [
    uuidColumn('uuid', 'UUID', (uuid) => regressionPath(suite, uuid)),
    {
      id: 'title',
      header: 'Title',
      cell: (regression) => {
        const title = regressionTitle(regression)
        const shown = truncate(title, TITLE_LENGTH)
        return (
          <Link
            to={regressionPath(suite, regression.uuid)}
            title={shown === title ? undefined : title}
          >
            {shown}
          </Link>
        )
      },
    },
    { id: 'state', header: 'State', cell: (regression) => <StateBadge state={regression.state} /> },
    {
      id: 'tests',
      header: 'Tests',
      looks: ['numeric'],
      cell: (regression) => regression.test_count,
    },
  ]
}
