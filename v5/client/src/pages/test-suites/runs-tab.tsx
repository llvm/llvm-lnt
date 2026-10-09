import { Link } from 'react-router'
import { queryKeys } from '../../api/keys'
import { fetchRunPage, type RunPage } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import type { Schemas } from '../../api/client'
import { DataTable, type Column } from '../../components/data-table'
import { CursorPager, PAGE_SIZE } from '../../components/pagination'
import { useServerSearch } from '../../components/use-server-search'
import { uuidColumn } from '../../components/uuid-column'
import { formatTimestamp } from '../../format'
import { commitPath, machinePath, runPath } from '../../paths'
import { displayValueOf } from '../../schema'
import { TabContent } from './tab-content'

type Run = Schemas['Run']

interface Props {
  schema: SuiteSchema
  search: string
  onSearch(text: string): void
}

/** The runs submitted to the suite, newest first (TS2). */
export function RunsTab({ schema, search, onSearch }: Props) {
  const suite = schema.name
  const input = useServerSearch(search, onSearch)
  const query = { search: search || undefined, sort: '-submitted_at', limit: PAGE_SIZE } as const
  const pager = useCursorPager({
    queryKey: [...queryKeys.suite(suite), 'runs', query],
    fetchPage: (cursor, signal) => fetchRunPage(suite, { ...query, cursor }, signal),
  })
  const page = pager.page

  return (
    <TabContent
      search={input}
      searchLabel="Search runs by machine, commit or UUID"
      placeholder="Search"
      isPending={pager.isPending}
      error={pager.error}
      onRetry={pager.retry}
      retrying={pager.isRetrying}
    >
      {page && (
        <>
          <DataTable
            label="Runs"
            columns={columns(schema, page)}
            rows={page.items}
            rowKey={(run) => run.uuid}
            empty={search ? 'No runs match this search.' : 'No runs yet.'}
            busy={input.pending || pager.isUpdating}
          />
          <CursorPager pager={pager} label="Runs pagination" />
        </>
      )}
    </TabContent>
  )
}

function columns(schema: SuiteSchema, page: RunPage): Column<Run>[] {
  const suite = schema.name
  return [
    uuidColumn('run', 'Run', (uuid) => runPath(suite, uuid)),
    {
      id: 'machine',
      header: 'Machine',
      cell: (run) => <Link to={machinePath(suite, run.machine)}>{run.machine}</Link>,
    },
    {
      id: 'commit',
      header: 'Commit',
      cell: (run) => (
        <Link to={commitPath(suite, run.commit)}>
          {displayValueOf(run.commit, page.commits, schema)}
        </Link>
      ),
    },
    {
      id: 'submitted',
      header: 'Submitted',
      looks: ['nowrap'],
      cell: (run) => formatTimestamp(run.submitted_at),
    },
  ]
}
