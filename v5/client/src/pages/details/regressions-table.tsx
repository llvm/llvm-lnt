import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { DataTable, type Column } from '../../components/data-table'
import { StateBadge } from '../../components/regression-state'
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
}

/**
 * The regressions related to the entity of a detail page: each one's title, linked to its page and
 * cut short, whole on hover, its state, and how many tests its indicators name (DT1).
 */
export function RegressionsTable({ suite, label, regressions, empty }: Props) {
  const columns: Column<Regression>[] = [
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
  return (
    <DataTable
      label={label}
      columns={columns}
      rows={regressions}
      rowKey={(regression) => regression.uuid}
      empty={empty}
    />
  )
}
