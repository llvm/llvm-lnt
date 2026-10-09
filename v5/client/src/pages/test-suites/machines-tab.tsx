import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import type { Schemas } from '../../api/client'
import { machinesQuery } from '../../api/machines'
import { shownData } from '../../api/shown-data'
import type { SuiteSchema } from '../../api/suites'
import { DataTable, type Column } from '../../components/data-table'
import { useServerSearch } from '../../components/use-server-search'
import { machinePath } from '../../paths'
import { formatFieldValue, labelOf } from '../../schema'
import { TabContent } from './tab-content'
import styles from './test-suites.module.css'

type Machine = Schemas['Machine']

const UNTRACKED_HELP =
  "Untracked machines are left out of the Dashboard's trend overview, but are listed and " +
  'usable everywhere else.'

interface Props {
  schema: SuiteSchema
  search: string
  onSearch(text: string): void
}

/** Every machine of the suite, by name (TS3). */
export function MachinesTab({ schema, search, onSearch }: Props) {
  const suite = schema.name
  const input = useServerSearch(search, onSearch)
  const machines = useQuery({
    ...machinesQuery(suite, search),
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

function columns(schema: SuiteSchema): Column<Machine>[] {
  return [
    {
      id: 'name',
      header: 'Name',
      looks: ['nowrap'],
      cell: (machine) => (
        <>
          <Link to={machinePath(schema.name, machine.name)}>{machine.name}</Link>
          {!machine.tracked && (
            <>
              {' '}
              <span className={styles.badge} title={UNTRACKED_HELP}>
                untracked
              </span>
            </>
          )}
        </>
      ),
    },
    { id: 'info', header: 'Info', cell: (machine) => machineInfo(schema, machine) },
  ]
}

/** The fields that have a value for `machine`, in schema order, separated by commas (TS3). */
function machineInfo(schema: SuiteSchema, machine: Machine): string {
  return schema.machine_fields
    .filter((field) => machine.fields[field.name] != null)
    .map((field) => {
      const value = formatFieldValue(machine.fields[field.name], field.type)
      return `${labelOf(field)}: ${value}`
    })
    .join(', ')
}
