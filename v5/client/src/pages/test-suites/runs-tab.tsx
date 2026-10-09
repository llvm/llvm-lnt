import { queryKeys } from '../../api/keys'
import { fetchRunPage, type RunPage } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { PAGE_SIZE, type Schemas } from '../../api/client'
import { DataTable, type Column } from '../../components/data-table'
import { CursorPager } from '../../components/pagination'
import { runColumns } from '../../components/run-columns'
import { useServerSearch } from '../../components/use-server-search'
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
    queryKey: [...queryKeys.runs(suite), query],
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
    >
      {page && (
        <>
          <DataTable
            label="Runs"
            columns={columns(schema, page)}
            rows={page.items}
            rowKey={(run) => run.uuid}
            empty={
              // A later page may only have run out.
              pager.hasPrevious
                ? 'No more runs.'
                : search
                  ? 'No runs match this search.'
                  : 'No runs yet.'
            }
            busy={input.pending || pager.isUpdating}
          />
          <CursorPager pager={pager} label="Runs pagination" />
        </>
      )}
    </TabContent>
  )
}

function columns(schema: SuiteSchema, page: RunPage): Column<Run>[] {
  const { run, machine, commit, submitted } = runColumns(schema, page.commits)
  return [run, machine, commit, submitted]
}
