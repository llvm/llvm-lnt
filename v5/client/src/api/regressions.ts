import { useMemo } from 'react'
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { api, authedApi, MAX_PAGE_SIZE, unwrap, type Schemas } from './client'
import { withCommits } from './commits'
import { failuresOf, type Failures } from './failures'
import { fetchEveryPage } from './fetch-every-page'
import { queryKeys } from './keys'
import type { paths } from './schema'

type RegressionListQuery = NonNullable<
  paths['/api/suites/{testsuite}/regressions']['get']['parameters']['query']
>
type RegressionDetail = Schemas['RegressionDetail']
type Indicator = Schemas['Indicator']
type IndicatorObject = Schemas['IndicatorObject']

export type RegressionSummary = Schemas['RegressionSummary']

/**
 * The regressions named by `uuids`, keyed by UUID, from one `POST /regressions/resolve` (E8): what
 * an indicator lookup that only names regression UUIDs needs to show their metadata. A UUID no
 * regression has is absent from the map.
 */
export async function resolveRegressions(
  suite: string,
  uuids: string[],
  signal?: AbortSignal,
): Promise<Map<string, RegressionSummary>> {
  const distinct = [...new Set(uuids)]
  if (distinct.length === 0) return new Map()
  const resolved = await unwrap(
    api.POST('/api/suites/{testsuite}/regressions/resolve', {
      params: { path: { testsuite: suite } },
      body: { regressions: distinct },
      signal,
    }),
  )
  return new Map(Object.entries(resolved.results))
}

/** E8's limit on a regression's title or bug (D5's column). */
export const TEXT_LENGTH = 256

/** The most indicators one request adds to or removes from a regression: I2's largest page (E8). */
export const INDICATOR_BATCH = MAX_PAGE_SIZE

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
 * for the whole page, to show their display values (AR6).
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

/** Add `indicators` to the regression `uuid` (E8): it answers with how many were new. */
export function addIndicators(suite: string, uuid: string, indicators: IndicatorObject[]) {
  return unwrap(
    authedApi.POST('/api/suites/{testsuite}/regressions/{uuid}/indicators', {
      params: { path: { testsuite: suite, uuid } },
      body: { indicators },
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
 * Store the regression `created`, for its page to show at once, and mark stale what shows the
 * suite's regressions elsewhere, to be fetched again when next shown.
 */
export async function regressionCreated(
  queryClient: QueryClient,
  suite: string,
  created: RegressionDetail,
): Promise<void> {
  // The detail is among what this marks stale, so it is stored after, which leaves it fresh.
  await queryClient.invalidateQueries({
    queryKey: queryKeys.regressions(suite),
    refetchType: 'none',
  })
  queryClient.setQueryData(regressionKey(suite, created.uuid), created)
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

/** A regression the Graph page marks (GR15), and the tests it affects among those asked about. */
export interface MarkedRegression {
  uuid: string
  title: string | null
  state: Schemas['RegressionStateName']
  /** The commit it is attributed to: a regression without one cannot be placed. */
  commit: string
  bug: string | null
  created_at: string
  tests: ReadonlySet<string>
}

/** What the Graph page marks regressions on: what it plots, and the states to show. */
export interface MarkedOn {
  machines: readonly string[]
  /** The tests asked about, which must exist, since the API refuses a test that does not (E8). */
  tests: readonly string[]
  metric: string
  states: readonly Schemas['RegressionStateName'][]
}

/** What is known of the regressions to mark (see `useMarkedRegressions`). */
export interface MarkedRegressions extends Failures {
  regressions: MarkedRegression[]
}

const NOTHING_MARKED: MarkedRegression[] = []

const NO_FAILURES: Failures = { error: null, retry: () => {} }

/**
 * The regressions in one of `states` with an indicator naming one of `machines`, `metric`, and one
 * of `tests`, attributed to a commit (GR15), unless `enabled` is false. Their indicators come from
 * the indicator lookup (E8), and their title, state and commit from resolving those regressions in
 * bulk (`POST /regressions/resolve`), joined on their UUID. The two are fetched apart, so that
 * selecting a test asks for the indicators only, and the regressions marked stay until they arrive.
 * Both are under the suite's regressions, which a change to one marks stale.
 */
export function useMarkedRegressions(
  suite: string,
  { machines, tests, metric, states }: MarkedOn,
  enabled: boolean,
): MarkedRegressions {
  const indicators = useQuery({
    queryKey: [
      ...queryKeys.regressions(suite),
      'marked',
      'indicators',
      { machines, tests, metric, states },
    ],
    queryFn: ({ signal }) =>
      fetchEveryPage((cursor) =>
        unwrap(
          api.POST('/api/suites/{testsuite}/regressions/indicators/query', {
            params: { path: { testsuite: suite } },
            body: {
              machine: [...machines],
              test: [...tests],
              metric,
              state: [...states],
              limit: MAX_PAGE_SIZE,
              cursor,
            },
            signal,
          }),
        ),
      ),
    enabled,
    placeholderData: keepPreviousData,
  })

  // By name, since a caller's lists may be new arrays of the same names.
  const askedMachines = machines.join('\0')
  const askedTests = tests.join('\0')

  const askedUuids = useMemo(() => {
    if (!enabled || indicators.data === undefined) return []
    const onMachines = new Set(askedMachines.split('\0'))
    const ofTests = new Set(askedTests.split('\0'))
    const found = new Set<string>()
    for (const { regression_uuid, machine, test } of indicators.data) {
      if (onMachines.has(machine) && ofTests.has(test)) {
        found.add(regression_uuid)
      }
    }
    return [...found].sort()
  }, [enabled, indicators.data, askedMachines, askedTests])

  const resolved = useQuery({
    queryKey: [...queryKeys.regressions(suite), 'marked', 'resolve', askedUuids],
    queryFn: ({ signal }) => resolveRegressions(suite, askedUuids, signal),
    enabled: enabled && indicators.data !== undefined,
    placeholderData: keepPreviousData,
  })

  const regressions = useMemo(() => {
    if (!enabled || indicators.data === undefined || resolved.data === undefined) return NOTHING_MARKED
    // The indicators kept from the previous lookup until the current one arrives may name machines
    // and tests that are no longer asked about.
    const onMachines = new Set(askedMachines.split('\0'))
    const ofTests = new Set(askedTests.split('\0'))
    const tested = new Map<string, Set<string>>()
    for (const { regression_uuid, machine, test } of indicators.data) {
      if (!onMachines.has(machine) || !ofTests.has(test)) continue
      let known = tested.get(regression_uuid)
      if (known === undefined) tested.set(regression_uuid, (known = new Set()))
      known.add(test)
    }
    const result: MarkedRegression[] = []
    for (const [uuid, tests] of tested) {
      const summary = resolved.data.get(uuid) ?? resolved.data.get(uuid.toLowerCase())
      if (summary === undefined || summary.commit === null) continue
      result.push({
        uuid: summary.uuid,
        title: summary.title,
        state: summary.state,
        commit: summary.commit,
        bug: summary.bug,
        created_at: summary.created_at,
        tests,
      })
    }
    return result
  }, [enabled, indicators.data, resolved.data, askedMachines, askedTests])

  // A query disabled keeps the error it last had.
  return { regressions, ...(enabled ? failuresOf([indicators, resolved]) : NO_FAILURES) }
}
