/**
 * The data of a profile (E7), read by its UUID: its metadata and top-level counters, its functions,
 * and a function's disassembly. A profile never changes once submitted (O7), so none of it is ever
 * fetched again while it is cached. The Profiles page keeps all of it for as long as it is open
 * (PF8), and forgets it once it has left, as profiles can be large (see `forgetProfiles`).
 */

import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { api, unwrap } from './client'
import { forgetEverySuiteLater, queryKeys } from './keys'

/** Kept as it is for as long as the Profiles page is open, which forgets it once it has left. */
const KEPT = { staleTime: Infinity, gcTime: Infinity } as const

/** The query key of the profile `uuid`, under which everything read about it is cached. */
export function profileKey(suite: string, uuid: string) {
  return [...queryKeys.profiles(suite), uuid] as const
}

/** The profile `uuid`: its test, its run and its top-level counters. */
export function profileQuery(suite: string, uuid: string) {
  return queryOptions({
    queryKey: profileKey(suite, uuid),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/profiles/{uuid}', {
          params: { path: { testsuite: suite, uuid } },
          signal,
        }),
      ),
    ...KEPT,
  })
}

/** The functions of the profile `uuid`, each with its counters, sorted by name. */
export function profileFunctionsQuery(suite: string, uuid: string) {
  return queryOptions({
    queryKey: [...profileKey(suite, uuid), 'functions'],
    queryFn: async ({ signal }) => {
      const { items } = await unwrap(
        api.GET('/api/suites/{testsuite}/profiles/{uuid}/functions', {
          params: { path: { testsuite: suite, uuid } },
          signal,
        }),
      )
      return items
    },
    ...KEPT,
  })
}

/** The instructions of the function `name` of the profile `uuid`, in order, with its counters. */
export function disassemblyQuery(suite: string, uuid: string, name: string) {
  return queryOptions({
    queryKey: [...profileKey(suite, uuid), 'disassembly', name],
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/profiles/{uuid}/disassembly', {
          params: { path: { testsuite: suite, uuid }, query: { function: name } },
          signal,
        }),
      ),
    ...KEPT,
    // Up to 100,000 instructions (O7), which a refetch would compare with the ones it replaces for
    // nothing: they cannot have changed.
    structuralSharing: false,
  })
}

/**
 * Forget the profile data that nothing shows, which the Profiles page keeps for as long as it is
 * open (PF8), once it has left: PF8 lets it, and a profile can be large (O7).
 */
export function forgetProfiles(client: QueryClient): void {
  forgetEverySuiteLater(client, queryKeys.profiles)
}
