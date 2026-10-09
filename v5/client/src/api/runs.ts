import { api, unwrap } from './client'
import { withCommits } from './commits'
import type { paths } from './schema'

type RunListQuery = NonNullable<paths['/api/suites/{testsuite}/runs']['get']['parameters']['query']>

/**
 * One page of `GET /runs` (E4), and its commits, resolved in one call for the whole page. Run lists
 * show each run's commit by its display value, which the runs do not carry (AR2).
 */
export async function fetchRunPage(
  suite: string,
  query: RunListQuery,
  signal?: AbortSignal,
) {
  const page = await unwrap(
    api.GET('/api/suites/{testsuite}/runs', {
      params: { path: { testsuite: suite }, query },
      signal,
    }),
  )
  return withCommits(
    suite,
    page,
    page.items.map((run) => run.commit),
    signal,
  )
}

/** A page of runs, with the commits they name, to show their display values. */
export type RunPage = Awaited<ReturnType<typeof fetchRunPage>>
