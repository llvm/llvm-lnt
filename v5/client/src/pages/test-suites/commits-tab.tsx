import { Link } from 'react-router'
import { PAGE_SIZE } from '../../api/client'
import { fetchCommitPage } from '../../api/commits'
import { queryKeys } from '../../api/keys'
import type { SuiteSchema } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { DataTable, type Column } from '../../components/data-table'
import { CursorPager } from '../../components/pagination'
import { useServerSearch } from '../../components/use-server-search'
import { MISSING } from '../../format'
import { commitPath } from '../../paths'
import { commitDisplayValue, type Commit } from '../../schema'
import { TabContent } from './tab-content'

interface Props {
  schema: SuiteSchema
  search: string
  onSearch(text: string): void
}

/**
 * The commits of the suite, most recently seen first (TS4), so that the commits that just arrived
 * are on the first page whether or not they have an ordinal.
 */
export function CommitsTab({ schema, search, onSearch }: Props) {
  const suite = schema.name
  const input = useServerSearch(search, onSearch)
  const query = { search: search || undefined, sort: '-first_seen', limit: PAGE_SIZE } as const
  const pager = useCursorPager({
    queryKey: [...queryKeys.suite(suite), 'commits', query],
    fetchPage: (cursor, signal) => fetchCommitPage(suite, { ...query, cursor }, signal),
  })
  const page = pager.page

  return (
    <TabContent
      search={input}
      searchLabel="Search commits"
      placeholder="Search commits..."
      isPending={pager.isPending}
      error={pager.error}
      onRetry={pager.retry}
    >
      {page && (
        <>
          <DataTable
            label="Commits"
            columns={columns(schema)}
            rows={page.items}
            rowKey={(commit) => commit.value}
            empty={
              // A later page may only have run out.
              pager.hasPrevious
                ? 'No more commits.'
                : search
                  ? 'No commits match this search.'
                  : 'No commits yet.'
            }
            busy={input.pending || pager.isUpdating}
          />
          <CursorPager pager={pager} label="Commits pagination" />
        </>
      )}
    </TabContent>
  )
}

function columns(schema: SuiteSchema): Column<Commit>[] {
  return [
    {
      id: 'commit',
      header: 'Commit',
      cell: (commit) => (
        // The tag has a column of its own, so the display value goes without it.
        <Link to={commitPath(schema.name, commit.value)}>
          {commitDisplayValue(commit, schema, { withTag: false })}
        </Link>
      ),
    },
    {
      id: 'ordinal',
      header: 'Ordinal',
      looks: ['numeric'],
      cell: (commit) => (commit.ordinal === null ? MISSING : String(commit.ordinal)),
    },
    { id: 'tag', header: 'Tag', cell: (commit) => commit.tag ?? MISSING },
  ]
}
