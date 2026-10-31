import { PAGE_SIZE } from '../../api/client'
import { fetchCommitPage } from '../../api/commits'
import { queryKeys } from '../../api/keys'
import { refOf, type Suite } from '../../api/suites'
import { useCursorPager } from '../../api/use-cursor-pager'
import { ListedCommitLink } from '../../components/commit-link'
import { DataTable, type Column } from '../../components/data-table'
import { CursorPager } from '../../components/pagination'
import { useServerSearch } from '../../components/use-server-search'
import { MISSING } from '../../format'
import type { Commit } from '../../schema'
import { listedColumns } from './listed-columns'
import { TabContent } from './tab-content'

interface Props {
  schema: Suite
  search: string
  onSearch(text: string): void
}

/**
 * The commits of the suite, most recently seen first (TS4), so that the commits that just arrived
 * are on the first page whether or not they have an ordinal.
 */
export function CommitsTab({ schema, search, onSearch }: Props) {
  const suite = refOf(schema)
  const input = useServerSearch(search, onSearch)
  const query = { search: search || undefined, sort: '-first_seen', limit: PAGE_SIZE } as const
  const pager = useCursorPager({
    queryKey: [...queryKeys.commits(suite), query],
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

function columns(schema: Suite): Column<Commit>[] {
  return [
    {
      id: 'commit',
      header: 'Commit',
      cell: (commit) => (
        // The tag has a column of its own, so the display value goes without it.
        <ListedCommitLink schema={schema} value={commit.value} commit={commit} withTag={false} />
      ),
    },
    {
      id: 'ordinal',
      header: 'Ordinal',
      looks: ['numeric'],
      cell: (commit) => (commit.ordinal === null ? MISSING : String(commit.ordinal)),
    },
    { id: 'tag', header: 'Tag', cell: (commit) => commit.tag ?? MISSING },
    ...listedColumns<Commit>(schema.commit_fields),
  ]
}
