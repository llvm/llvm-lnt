import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import { withCommits } from './commits'
import { queryKeys } from './keys'
import type { paths } from './schema'

type RunListQuery = NonNullable<paths['/api/suites/{testsuite}/runs']['get']['parameters']['query']>

/** One page of `GET /runs` (E4). */
export function fetchRuns(suite: string, query: RunListQuery, signal?: AbortSignal) {
  return unwrap(
    api.GET('/api/suites/{testsuite}/runs', {
      params: { path: { testsuite: suite }, query },
      signal,
    }),
  )
}

/**
 * One page of `GET /runs` (E4), and its commits, resolved in one call for the whole page. Run lists
 * show each run's commit by its display value, which the runs do not carry (AR2).
 */
export async function fetchRunPage(
  suite: string,
  query: RunListQuery,
  signal?: AbortSignal,
) {
  const page = await fetchRuns(suite, query, signal)
  return withCommits(
    suite,
    page,
    page.items.map((run) => run.commit),
    signal,
  )
}

/** A page of runs, with the commits they name, to show their display values. */
export type RunPage = Awaited<ReturnType<typeof fetchRunPage>>

/** The query key of the run `uuid`, under which everything read about it is cached. */
export function runKey(suite: string, uuid: string) {
  return [...queryKeys.runs(suite), 'detail', uuid] as const
}

/** The run `uuid` (E4), with its `run_parameters`. */
export function useRun(suite: string, uuid: string) {
  return useQuery({
    queryKey: runKey(suite, uuid),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/runs/{uuid}', {
          params: { path: { testsuite: suite, uuid } },
          signal,
        }),
      ),
  })
}

/** The tests of the run `uuid` that have a profile, each with its profile's UUID (E7). */
export function useRunProfiles(suite: string, uuid: string) {
  return useQuery({
    queryKey: [...runKey(suite, uuid), 'profiles'],
    queryFn: async ({ signal }) => {
      const { items } = await unwrap(
        api.GET('/api/suites/{testsuite}/runs/{uuid}/profiles', {
          params: { path: { testsuite: suite, uuid } },
          signal,
        }),
      )
      return items
    },
    // A run's profiles never change (O7).
    staleTime: Infinity,
  })
}
