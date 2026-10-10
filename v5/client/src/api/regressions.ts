import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { api, authedApi, unwrap, type Schemas } from './client'
import { withCommits } from './commits'
import { queryKeys } from './keys'
import type { paths } from './schema'

type RegressionListQuery = NonNullable<
  paths['/api/suites/{testsuite}/regressions']['get']['parameters']['query']
>
type RegressionDetail = Schemas['RegressionDetail']
type Indicator = Schemas['Indicator']

/** E8's limit on a regression's title or bug (D5's column). */
export const TEXT_LENGTH = 256

/** One page of `GET /regressions` (E8). */
export function fetchRegressions(suite: string, query: RegressionListQuery, signal?: AbortSignal) {
  return unwrap(
    api.GET('/api/suites/{testsuite}/regressions', {
      params: { path: { testsuite: suite }, query },
      signal,
    }),
  )
}

/**
 * One page of `GET /regressions` (E8), and the commits its regressions name, resolved in one call
 * for the whole page, to show their display values (AR2).
 */
export async function fetchRegressionPage(
  suite: string,
  query: RegressionListQuery,
  signal?: AbortSignal,
) {
  const page = await fetchRegressions(suite, query, signal)
  const values = page.items.flatMap((regression) => regression.commit ?? [])
  return withCommits(suite, page, values, signal)
}

/** A page of regressions, with the commits they name, to show their display values. */
export type RegressionPage = Awaited<ReturnType<typeof fetchRegressionPage>>

/** Delete the regression `uuid` (E8). */
export function deleteRegression(suite: string, uuid: string) {
  return unwrap(
    authedApi.DELETE('/api/suites/{testsuite}/regressions/{uuid}', {
      params: { path: { testsuite: suite, uuid } },
    }),
  )
}

/** The query key of the regression `uuid`'s detail, with its notes and indicators (E8). */
export function regressionKey(suite: string, uuid: string) {
  return [...queryKeys.regressions(suite), 'detail', uuid] as const
}

/**
 * The mutation scope of every change to the regression `uuid`, which runs them one after the
 * other, so that the answer to an earlier one, arriving late, does not replace a later one's.
 */
export function regressionScope(suite: string, uuid: string) {
  return { id: JSON.stringify(regressionKey(suite, uuid)) }
}

/**
 * The regression `uuid` (E8), with its notes and indicators. Unless `fetch` is true, it is only read
 * from the cache, as another part of the page fetches it.
 */
export function useRegression(suite: string, uuid: string, { fetch = true } = {}) {
  return useQuery({
    queryKey: regressionKey(suite, uuid),
    enabled: fetch,
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/regressions/{uuid}', {
          params: { path: { testsuite: suite, uuid } },
          signal,
        }),
      ),
  })
}

/**
 * Store what a change to the regression `uuid` returned, applied by `change` to the regression as
 * stored -- an answer may hold only part of it, such as its indicators -- and mark stale what shows
 * the suite's regressions elsewhere -- lists, with their titles, states, commits and counts -- to
 * be fetched again when next shown. The changes run one after the other (see `regressionScope`),
 * so that each answer is to a request made after the previous one was answered.
 */
export async function regressionChanged(
  queryClient: QueryClient,
  suite: string,
  uuid: string,
  change: (stored: RegressionDetail) => RegressionDetail,
): Promise<void> {
  // The detail is among what this marks stale, so it is stored after, which leaves it fresh.
  await queryClient.invalidateQueries({
    queryKey: queryKeys.regressions(suite),
    refetchType: 'none',
  })
  queryClient.setQueryData<RegressionDetail>(
    regressionKey(suite, uuid),
    (stored) => stored && change(stored),
  )
}

/**
 * A mutation changing the regression `uuid` through `mutationFn`, one of E8's routes, whose answer
 * `change` applies to the regression as stored (see `regressionChanged`). Every change to the
 * regression runs in its scope (see `regressionScope`).
 */
export function useRegressionMutation<Variables, Result>(
  suite: string,
  uuid: string,
  mutationFn: (variables: Variables) => Promise<Result>,
  change: (result: Result, stored: RegressionDetail) => RegressionDetail,
) {
  const queryClient = useQueryClient()
  return useMutation({
    scope: regressionScope(suite, uuid),
    // A fetch of the regression under way could land after the answer, and show it as it was.
    onMutate: () => queryClient.cancelQueries({ queryKey: regressionKey(suite, uuid) }),
    mutationFn,
    onSuccess: (result) =>
      regressionChanged(queryClient, suite, uuid, (stored) => change(result, stored)),
  })
}

/** `stored`, with the indicators an indicator route (E8) answered with: the whole list afterwards. */
export function withIndicators(
  { indicators }: { indicators: Indicator[] },
  stored: RegressionDetail,
): RegressionDetail {
  return { ...stored, indicators }
}
