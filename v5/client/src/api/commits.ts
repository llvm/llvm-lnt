import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
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
 * The commit `value`, resolved on its own for its display value and ordinal (E3), or null once it
 * shows that no commit has that value.
 */
export function useResolvedCommit(suite: string, value: string) {
  return useQuery({
    queryKey: [...queryKeys.suite(suite), 'commits', 'resolve', value],
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
 * the others). The lookup is cached per machine and commit, so that runs of the same machine at
 * the same commit share it.
 */
export function usePreviousCommit(suite: string, value: string, machine: string): PreviousCommit {
  const commit = useResolvedCommit(suite, value)
  const ordered = commit.data?.ordinal != null
  const lookup = useQuery({
    queryKey: [...queryKeys.suite(suite), 'commits', 'previous', { machine, commit: value }],
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
