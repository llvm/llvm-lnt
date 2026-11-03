import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { machinesQuery } from '../../api/machines'
import { shownData } from '../../api/shown-data'
import { refOf, type Suite } from '../../api/suites'
import { Badge } from '../../components/badge'
import { DataTable, type Column } from '../../components/data-table'
import { useServerSearch } from '../../components/use-server-search'
import { UNTRACKED_HELP } from '../../machines'
import { machinePath } from '../../paths'
import { listedColumns } from './listed-columns'
import { TabContent } from './tab-content'

type Machine = Schemas['Machine']

interface Props {
  schema: Suite
  search: string
  onSearch(text: string): void
}

/** Every machine of the suite, by name, with the fields the schema lists (TS3). */
export function MachinesTab({ schema, search, onSearch }: Props) {
  const suite = refOf(schema)
  const input = useServerSearch(search, onSearch)
  const machines = useQuery({
    ...machinesQuery(suite, { search: search || undefined }),
    // Keep the machines shown until those of the next search arrive.
    placeholderData: keepPreviousData,
  })
  const shown = shownData(machines)

  return (
    <TabContent
      search={input}
      searchLabel="Search machines"
      placeholder="Search machines..."
      isPending={shown === undefined}
      error={machines.error}
      onRetry={() => void machines.refetch()}
    >
      {shown && (
        <DataTable
          label="Machines"
          columns={columns(schema)}
          rows={shown}
          rowKey={(machine) => machine.name}
          empty={search ? 'No machines match this search.' : 'No machines yet.'}
          busy={input.pending || machines.isPlaceholderData}
        />
      )}
    </TabContent>
  )
}

function columns(schema: Suite): Column<Machine>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      looks: ['nowrap'],
      cell: (machine) => (
        <>
          <Link to={machinePath(refOf(schema), machine.name)}>{machine.name}</Link>
          {!machine.tracked && (
            <>
              {' '}
              <Badge help={UNTRACKED_HELP}>untracked</Badge>
            </>
          )}
        </>
      ),
    },
    ...listedColumns<Machine>(schema.machine_fields),
  ]
}
