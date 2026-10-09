import { useQuery } from '@tanstack/react-query'
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
