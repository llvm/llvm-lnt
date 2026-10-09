import { api, unwrap } from './client'
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
export async function resolveCommits(
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
 * `page`, with the commits named by `values` resolved in one call: what a list naming commits needs
 * to show their display values (AR2).
 */
export async function withCommits<Page>(
  suite: string,
  page: Page,
  values: string[],
  signal?: AbortSignal,
): Promise<Page & { commits: Map<string, Commit> }> {
  return { ...page, commits: await resolveCommits(suite, values, signal) }
}
