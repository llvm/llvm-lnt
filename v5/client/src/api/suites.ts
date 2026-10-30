import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { compareStrings } from '../format'
import { compareSuites, suiteLabelOf } from '../labels'
import { forgetSuite, queryKeys } from './keys'

export type SuiteSchema = Schemas['SuiteSchema']

/** The suites of the list the API returned, in the order the UI lists suites in (AR22). */
function inOrder(list: Schemas['SuiteSchemaList']): SuiteSchema[] {
  return [...list.items].sort(compareSuites)
}

const suitesQuery = queryOptions({
  queryKey: queryKeys.suites,
  queryFn: ({ signal }) => unwrap(api.GET('/api/suites', { signal })),
  select: inOrder,
})

/**
 * The test suites of the instance, with their schemas, in the order the UI lists them (AR22).
 * Suites are few, and the list carries every schema, so pages read a suite's schema from it rather
 * than fetching it on its own.
 */
export function useSuites() {
  return useQuery(suitesQuery)
}

/**
 * The suites as far as they have been listed already, without listing them: for what names a suite
 * by its label (AR22) without needing the list otherwise, which names it by its name until then.
 */
export function useKnownSuites(): SuiteSchema[] | undefined {
  return useQuery({ ...suitesQuery, enabled: false }).data
}

/** The label of the suite `name` (AR22), or its name until the suites are listed. */
export function useSuiteLabel(name: string): string {
  return suiteLabelOf(useKnownSuites(), name)
}

/** Fetch the list of suites again, after a write that found it out of date. */
export function refetchSuites(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.suites, exact: true })
}

/**
 * Put `schema`, as the API returned it after a write, in the list of suites: in place of the
 * suite's schema, or by name. A list on its way, which may not hold it yet, is cancelled, and asked
 * for again, since it may have held more than the cache does, such as a suite created elsewhere.
 */
async function putSuite(queryClient: QueryClient, schema: SuiteSchema): Promise<void> {
  const fetching = queryClient.isFetching({ queryKey: queryKeys.suites, exact: true }) > 0
  await queryClient.cancelQueries({ queryKey: queryKeys.suites, exact: true })
  queryClient.setQueryData<Schemas['SuiteSchemaList']>(queryKeys.suites, (list) => {
    if (list === undefined) return list
    const others = list.items.filter((entry) => entry.name !== schema.name)
    return { items: [...others, schema].sort((a, b) => compareStrings(a.name, b.name)) }
  })
  if (fetching) refetchSuites(queryClient)
}

/**
 * Add the created `schema` to the list of suites, and drop everything read from inside an earlier
 * suite of the same name, deleted elsewhere, so that the new one starts afresh.
 */
export async function addSuite(queryClient: QueryClient, schema: SuiteSchema): Promise<void> {
  await putSuite(queryClient, schema)
  queryClient.removeQueries({ queryKey: queryKeys.suite(schema.name) })
}

/**
 * Put the changed `schema` in the list of suites, and forget what was read from inside the suite,
 * whose fields or metrics may have changed.
 */
export async function updateSuite(queryClient: QueryClient, schema: SuiteSchema): Promise<void> {
  await putSuite(queryClient, schema)
  await forgetSuite(queryClient, schema.name, { leaving: false })
}

/**
 * Forget the deleted `suite`: cancel a list of suites on its way, which may still hold it, drop it
 * from the cached list, and drop everything read from inside it, so that a suite created later
 * under the same name starts afresh. The list of API keys goes too, since the suite is gone from
 * the keys restricted to it (I5), which would otherwise still show it.
 */
export async function removeSuite(queryClient: QueryClient, suite: string): Promise<void> {
  await queryClient.cancelQueries({ queryKey: queryKeys.suites })
  queryClient.setQueryData<Schemas['SuiteSchemaList']>(
    queryKeys.suites,
    (list) => list && { items: list.items.filter((entry) => entry.name !== suite) },
  )
  queryClient.removeQueries({ queryKey: queryKeys.suite(suite) })
  queryClient.removeQueries({ queryKey: queryKeys.apiKeys, type: 'inactive' })
  void queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys })
}
