import { partialMatchKey, useQuery, type Query, type QueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'
import type { paths } from './schema'
import type { Commit } from '../schema'

type CommitListQuery = NonNullable<
  paths['/api/suites/{testsuite}/commits']['get']['parameters']['query']
>

/** One page of `GET /commits` (E3), most recently seen first unless `query` sorts otherwise. */
export function fetchCommitPage(suite: string, query: CommitListQuery, signal?: AbortSignal) {
  return unwrap(
    api.GET('/api/suites/{testsuite}/commits', {
      params: { path: { testsuite: suite }, query: { sort: '-first_seen', ...query } },
      signal,
    }),
  )
}

/**
 * The commits named by `values`, keyed by value, from one `POST /commits/resolve` (E3): what a list
 * that only names its commits, such as a page of runs, needs to show their display values (AR2).
 * A value no commit has, deleted since the list was read, say, is absent from the map.
 */
async function resolveCommits(
  suite: string,
  values: string[],
  signal?: AbortSignal,
): Promise<Map<string, Commit>> {
  const commits = [...new Set(values)]
  if (commits.length === 0) return new Map()
  const resolved = await unwrap(
    api.POST('/api/suites/{testsuite}/commits/resolve', {
      params: { path: { testsuite: suite } },
      body: { commits },
      signal,
    }),
  )
  return new Map(Object.entries(resolved.results))
}

/**
 * Which commits a commit picker offers (AR2 "Commit pickers"): the `GET /commits` filters (E3) it
 * passes on. No filter offers every commit of the suite.
 */
export interface CommitFilters {
  /** Only commits with a run on this machine. */
  machine?: string
  /** Only commits with a run that has profiles (on `machine`, if given). */
  has_profiles?: true
}

/**
 * The commit `value`, if the commit list under `filters` holds it, and null otherwise: how a commit
 * picker checks that it would offer a commit it was given (AR2 "Commit pickers"), with its filters
 * plus `commit=` (E3).
 */
export async function lookUpCommit(
  suite: string,
  filters: CommitFilters,
  value: string,
  signal?: AbortSignal,
): Promise<Commit | null> {
  return firstCommit(suite, { ...filters, commit: value }, signal)
}

/** The first commit `GET /commits` lists for `query` (E3), or null if it lists none. */
async function firstCommit(suite: string, query: CommitListQuery, signal?: AbortSignal) {
  const page = await fetchCommitPage(suite, { ...query, limit: 1 }, signal)
  return page.items[0] ?? null
}

/**
 * `page`, with the commits named by `values` resolved in one call: what a list naming commits needs
 * to show their display values (AR2). If they cannot be resolved, the page goes without them, and
 * shows the commit strings instead, rather than fail for want of a way to display them.
 */
export async function withCommits<Page>(
  suite: string,
  page: Page,
  values: string[],
  signal?: AbortSignal,
): Promise<Page & { commits: Map<string, Commit> }> {
  let commits = new Map<string, Commit>()
  try {
    commits = await resolveCommits(suite, values, signal)
  } catch (error) {
    // Cancelled along with the page, which TanStack Query must see as such.
    if (signal?.aborted) throw error
  }
  return { ...page, commits }
}

/**
 * Whether `query` holds the commits of a list, resolved by `withCommits` for display. Lists shown a
 * page at a time hold them; no list loaded page after page (`useCursorPages`) resolves its commits.
 */
function holdsCommits(query: Query): boolean {
  const data = query.state.data
  return typeof data === 'object' && data !== null && 'commits' in data
}

/**
 * Mark stale what shows a commit of `suite`, after a change to its ordinal or tag: every query
 * about commits, and every list that holds its commits' display values. Nothing is fetched again
 * until it is shown. What names a commit only by its value is left alone, such as a run's samples,
 * which never change and would otherwise all be fetched again when next shown.
 */
export async function commitChanged(queryClient: QueryClient, suite: string): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: queryKeys.suite(suite),
    predicate: (query) =>
      partialMatchKey(query.queryKey, queryKeys.commits(suite)) || holdsCommits(query),
    refetchType: 'none',
  })
}

/** The query key of the commit `value`'s detail, with its neighbours (E3). */
export function commitKey(suite: string, value: string) {
  return [...queryKeys.commits(suite), 'detail', value] as const
}

/** The query key of the commit `value` resolved on its own (see `useResolvedCommit`). */
export function resolvedCommitKey(suite: string, value: string) {
  return [...queryKeys.commits(suite), 'resolve', value] as const
}

/** `detail`, without its neighbours: the commit as a list or `commits/resolve` gives it. */
export function withoutNeighbours(detail: Schemas['CommitDetail']): Commit {
  const { value, ordinal, tag, fields } = detail
  return { value, ordinal, tag, fields }
}

/** Store `detail` as the commit resolved, which a page about it then need not ask for again. */
function storeResolved(queryClient: QueryClient, suite: string, detail: Schemas['CommitDetail']) {
  queryClient.setQueryData(resolvedCommitKey(suite, detail.value), withoutNeighbours(detail))
}

/** Store `detail`, as the API returned it, as both the commit's detail and its resolution. */
export function storeCommit(
  queryClient: QueryClient,
  suite: string,
  detail: Schemas['CommitDetail'],
): void {
  queryClient.setQueryData(commitKey(suite, detail.value), detail)
  storeResolved(queryClient, suite, detail)
}

/** Cancel the fetches of the commit `value` under way, whose answers could replace a newer one. */
export async function cancelCommit(queryClient: QueryClient, suite: string, value: string) {
  await Promise.all(
    [commitKey(suite, value), resolvedCommitKey(suite, value)].map((queryKey) =>
      queryClient.cancelQueries({ queryKey }),
    ),
  )
}

/**
 * The commit `value` (E3), with the commits before and after it in ordinal order. The commit is
 * also stored as resolved (see `useResolvedCommit`), which a page about it need not ask for again.
 */
export function useCommit(suite: string, value: string) {
  return useQuery({
    queryKey: commitKey(suite, value),
    queryFn: async ({ client, signal }) => {
      const commit = await unwrap(
        api.GET('/api/suites/{testsuite}/commits/{value}', {
          params: { path: { testsuite: suite, value } },
          signal,
        }),
      )
      storeResolved(client, suite, commit)
      return commit
    },
  })
}

/**
 * The commit `value`, resolved on its own for its display value and ordinal (E3), or null once it
 * shows that no commit has that value.
 */
export function useResolvedCommit(suite: string, value: string) {
  return useQuery({
    queryKey: resolvedCommitKey(suite, value),
    queryFn: async ({ signal }) =>
      (await resolveCommits(suite, [value], signal)).get(value) ?? null,
  })
}

/**
 * What is known of the commit before a run's on its machine (see `usePreviousCommit`): whether it
 * is still being looked up, could not be, does not exist, or was found.
 */
export type PreviousCommit =
  | { state: 'pending' }
  | { state: 'failed'; error: unknown }
  /** The run's commit has no ordinal, so no commit comes before it. */
  | { state: 'unordered' }
  /** The machine has no run at an earlier commit. */
  | { state: 'none' }
  | { state: 'found'; commit: Commit }

/**
 * The commit before `value` at which `machine` has runs: the one with the nearest lower ordinal
 * among the machine's commits (DT2), which the commit's own `previous` neighbour need not be. The
 * commit is resolved first, since only one with an ordinal has a commit before it (the API refuses
 * the others). The lookup is cached per machine, commit and ordinal, so that runs of the same
 * machine at the same commit share it, and a new ordinal looks it up again.
 */
export function usePreviousCommit(suite: string, value: string, machine: string): PreviousCommit {
  const commit = useResolvedCommit(suite, value)
  const ordinal = commit.data?.ordinal
  const ordered = ordinal != null
  const lookup = useQuery({
    queryKey: [...queryKeys.commits(suite), 'previous', { machine, commit: value, ordinal }],
    queryFn: ({ signal }) =>
      firstCommit(suite, { machine, before_commit: value, sort: '-ordinal' }, signal),
    enabled: ordered,
  })
  if (commit.isError) return { state: 'failed', error: commit.error }
  if (commit.isPending) return { state: 'pending' }
  // Deleted since the run was read.
  if (commit.data === null) {
    return { state: 'failed', error: new Error(`Commit '${value}' no longer exists.`) }
  }
  if (!ordered) return { state: 'unordered' }
  if (lookup.isError) return { state: 'failed', error: lookup.error }
  if (lookup.isPending) return { state: 'pending' }
  return lookup.data ? { state: 'found', commit: lookup.data } : { state: 'none' }
}
