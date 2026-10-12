import { replaceEqualDeep, useQuery } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { withCommits } from './commits'
import { queryKeys } from './keys'

export type TrendPoint = Schemas['TrendPoint']

interface TrendQuery {
  metric: string
  machines: string[]
  /** How many of the most recent commits with data the trend covers (E9). */
  lastN: number
}

/**
 * The trend of `suite`'s `metric` on `machines` (E9), with the commits it names resolved in one
 * call, to show their display values (AR6): trend items carry no commit fields.
 */
async function fetchTrend(
  suite: string,
  { metric, machines, lastN }: TrendQuery,
  signal: AbortSignal,
) {
  const trend = await unwrap(
    api.GET('/api/suites/{testsuite}/trends', {
      params: { path: { testsuite: suite }, query: { metric, machine: machines, last_n: lastN } },
      signal,
    }),
  )
  return withCommits(suite, trend, trend.items.map((point) => point.commit), signal)
}

type Trend = Awaited<ReturnType<typeof fetchTrend>>

/**
 * `next`, keeping what it has in common with `previous`: `previous` itself if both hold the same
 * trend and commits, or else `previous`'s items if those are the same. TanStack Query's own
 * structural sharing does not look into the commits, a `Map`, so without this a refetch that
 * brings nothing new would still give new data, and redraw every chart drawn from it.
 */
function keepUnchanged(previous: Trend | undefined, next: Trend): Trend {
  if (previous === undefined) return next
  const items = replaceEqualDeep(previous.items, next.items)
  const sameCommits =
    previous.commits.size === next.commits.size &&
    [...next.commits].every(([value, commit]) => {
      const old = previous.commits.get(value)
      return old !== undefined && replaceEqualDeep(old, commit) === old
    })
  return items === previous.items && sameCommits ? previous : { ...next, items }
}

/** The trend of `metric` on `machines` (E9), with the commits it names resolved. */
export function useTrends(suite: string, query: TrendQuery) {
  return useQuery({
    queryKey: [...queryKeys.trends(suite), query],
    queryFn: ({ signal }) => fetchTrend(suite, query, signal),
    structuralSharing: (previous, next) =>
      keepUnchanged(previous as Trend | undefined, next as Trend),
  })
}
