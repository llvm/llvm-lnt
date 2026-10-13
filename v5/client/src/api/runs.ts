import { useCallback } from 'react'
import { queryOptions, useQueries, useQuery } from '@tanstack/react-query'
import { api, MAX_PAGE_SIZE, unwrap, type Schemas } from './client'
import { withCommits } from './commits'
import { fetchEveryPage } from './fetch-every-page'
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
 * show each run's commit by its display value, which the runs do not carry (AR6).
 */
export async function fetchRunPage(suite: string, query: RunListQuery, signal?: AbortSignal) {
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
export function runProfilesQuery(suite: string, uuid: string) {
  return queryOptions({
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

/**
 * The runs of `machine` at `commit` (E4), every one of them that `filters` keeps, in the order they
 * were submitted: the runs a side of the Compare page selects among (CP1), or those with profiles.
 */
export function commitRunsQuery(
  suite: string,
  machine: string,
  commit: string,
  filters: { has_profiles?: true } = {},
) {
  const query = { machine, commit, ...filters }
  return queryOptions({
    queryKey: [...queryKeys.runs(suite), 'of-commit', query],
    queryFn: ({ signal }) =>
      fetchEveryPage((cursor) =>
        fetchRuns(suite, { ...query, sort: 'submitted_at', limit: MAX_PAGE_SIZE, cursor }, signal),
      ),
  })
}

type Sample = Schemas['Sample']

/** One page of the samples of the run `uuid` (E6), I2's largest: a run can have thousands. */
export function fetchSamplePage(
  suite: string,
  uuid: string,
  cursor: string | null,
  signal?: AbortSignal,
) {
  return unwrap(
    api.GET('/api/suites/{testsuite}/runs/{uuid}/samples', {
      params: { path: { testsuite: suite, uuid }, query: { cursor, limit: MAX_PAGE_SIZE } },
      signal,
    }),
  )
}

/** A run of a suite, whose samples `useRunSamples` loads. */
export interface RunRef {
  suite: string
  uuid: string
}

/** What identifies a run among those of every suite: neither a suite name nor a UUID has a `/`. */
export function runRefKey({ suite, uuid }: RunRef): string {
  return `${suite}/${uuid}`
}

/** The runs of `lists`, each once. */
export function uniqueRuns(...lists: (readonly RunRef[])[]): RunRef[] {
  const unique = new Map(lists.flat().map((ref) => [runRefKey(ref), ref]))
  return [...unique.values()]
}

/** How far a run's samples are loaded. */
export interface SampleState {
  /** Every sample of the run, once they have all arrived. */
  samples: Sample[] | undefined
  /** Why they could not be, if they could not. */
  error: Error | null
  /** Fetch them again, after a failure. */
  retry(): void
}

/**
 * The samples of `runs` (E6), each run's fetched whole, and kept for good once they are, since a
 * run's samples never change. Only the runs `wanted` names (by `runRefKey`) are fetched. A run that
 * is no longer wanted but is still among `runs` goes on loading, whereas one that leaves `runs`
 * stops (CP6).
 */
export function useRunSamples(
  runs: readonly RunRef[],
  wanted: ReadonlySet<string>,
): ReadonlyMap<string, SampleState> {
  const combine = useCallback(
    (results: { data?: Sample[]; error: Error | null; refetch: () => unknown }[]) =>
      new Map(
        results.map(({ data, error, refetch }, i): [string, SampleState] => [
          runRefKey(runs[i]),
          { samples: data, error, retry: () => void refetch() },
        ]),
      ),
    [runs],
  )
  return useQueries({
    queries: runs.map((run) => ({
      queryKey: [...runKey(run.suite, run.uuid), 'sample-list'],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        fetchEveryPage((cursor) => fetchSamplePage(run.suite, run.uuid, cursor, signal)),
      enabled: wanted.has(runRefKey(run)),
      staleTime: Infinity,
      // Samples are read whole, never compared with previous ones.
      structuralSharing: false,
    })),
    combine,
  })
}
