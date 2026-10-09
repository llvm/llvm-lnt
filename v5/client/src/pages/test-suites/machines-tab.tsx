import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { api, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import { useLastData } from '../../api/use-last-data'
import type { SuiteSchema } from '../../api/suites'
import { DataTable, type Column } from '../../components/data-table'
import { OffsetPager, PAGE_SIZE } from '../../components/pagination'
import { useServerSearch } from '../../components/use-server-search'
import { machinePath } from '../../paths'
import { formatFieldValue, labelOf } from '../../schema'
import { useDropUnusable } from '../../url-state'
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
  offset: number
  onOffset(offset: number): void
}

/** The machines of the suite, by name, a page at a time (TS3). */
export function MachinesTab({ schema, search, onSearch, offset, onOffset }: Props) {
  const suite = schema.name
  const input = useServerSearch(search, onSearch)
  const params = { search: search || undefined, limit: PAGE_SIZE, offset }
  const machines = useQuery({
    queryKey: [...queryKeys.suite(suite), 'machines', params],
    // With its offset, so that a page shown in place of another (see below) says where it is.
    queryFn: async ({ signal }) => {
      const request = api.GET('/api/suites/{testsuite}/machines', {
        params: { path: { testsuite: suite }, query: params },
        signal,
      })
      return { ...(await unwrap(request)), offset }
    },
    placeholderData: keepPreviousData,
  })
  // An offset past the last machine is one the page cannot use (AR2 "State").
  useDropUnusable(
    machines,
    (page) => offset === 0 || page.items.length > 0,
    () => onOffset(0),
  )
  // The page shown: the previous one while the one asked for loads, or the last one that loaded
  // when it failed, next to the error.
  const page = useLastData(machines.data)
  // Asking again for the page that failed retries it.
  const goTo = (to: number) => (to === offset ? void machines.refetch() : onOffset(to))

  return (
    <TabContent
      search={input}
      searchLabel="Search machines"
      placeholder="Search machines..."
      isPending={machines.isPending}
      error={machines.error}
    >
      {page && (
        <>
          <DataTable
            label="Machines"
            columns={columns(schema)}
            rows={page.items}
            rowKey={(machine) => machine.name}
            empty={search ? 'No machines match this search.' : 'No machines yet.'}
            busy={input.pending || machines.isPlaceholderData}
          />
          <OffsetPager
            label="Machines pagination"
            offset={page.offset}
            limit={PAGE_SIZE}
            count={page.items.length}
            total={page.total}
            disabled={machines.isPlaceholderData}
            onChange={goTo}
          />
        </>
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
