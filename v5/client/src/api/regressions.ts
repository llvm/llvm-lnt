import { api, unwrap } from './client'
import { withCommits } from './commits'
import type { paths } from './schema'

type RegressionListQuery = NonNullable<
  paths['/api/suites/{testsuite}/regressions']['get']['parameters']['query']
>

/**
 * One page of `GET /regressions` (E8), and the commits its regressions name, resolved in one call
 * for the whole page, to show their display values (AR2).
 */
export async function fetchRegressionPage(
  suite: string,
  query: RegressionListQuery,
  signal?: AbortSignal,
) {
  const page = await unwrap(
    api.GET('/api/suites/{testsuite}/regressions', {
      params: { path: { testsuite: suite }, query },
      signal,
    }),
  )
  const values = page.items.flatMap((regression) => regression.commit ?? [])
  return withCommits(suite, page, values, signal)
}

/** A page of regressions, with the commits they name, to show their display values. */
export type RegressionPage = Awaited<ReturnType<typeof fetchRegressionPage>>
