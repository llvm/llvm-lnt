import { useQuery, type QueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { compareStrings } from '../format'
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
 * Add the created `schema` to the list of suites: cancel a list on its way, which may not hold it
 * yet, insert it into the cached list by name, and drop everything read from inside an earlier
 * suite of the same name, deleted elsewhere, so that the new one starts afresh. Then fetch the list
 * again.
 */
export async function addSuite(queryClient: QueryClient, schema: SuiteSchema): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.suites })
  queryClient.setQueryData<Schemas['SuiteSchemaList']>(queryKeys.suites, (list) => {
    if (list === undefined) return list
    const others = list.items.filter((entry) => entry.name !== schema.name)
    return { items: [...others, schema].sort((a, b) => compareStrings(a.name, b.name)) }
  })
  queryClient.removeQueries({ queryKey: queryKeys.suite(schema.name) })
  // The list cancelled may have held more than the cache does, such as a suite created elsewhere:
  // ask for it again, now that it holds the new suite too.
  void queryClient.invalidateQueries({ queryKey: queryKeys.suites, exact: true })
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
