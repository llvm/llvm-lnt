import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'

export type SuiteSchema = Schemas['SuiteSchema']

/**
 * The test suites of the instance, with their schemas, ordered by name (E10). Suites are few, and
 * the list carries every schema, so pages read a suite's schema from it rather than fetching it on
 * its own.
 */
export function useSuites() {
  return useQuery({
    queryKey: queryKeys.suites,
    queryFn: ({ signal }) => unwrap(api.GET('/api/suites', { signal })),
    select: (list) => list.items,
  })
}

/**
 * Forget the deleted `suite`: cancel a list of suites on its way, which may still hold it, drop it
 * from the cached list, and drop everything read from inside it, so that a suite created later
 * under the same name starts afresh.
 */
export async function removeSuite(queryClient: QueryClient, suite: string): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.suites })
  queryClient.setQueryData<Schemas['SuiteSchemaList']>(
    queryKeys.suites,
    (list) => list && { items: list.items.filter((entry) => entry.name !== suite) },
  )
  queryClient.removeQueries({ queryKey: queryKeys.suite(suite) })
}
