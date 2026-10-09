import { queryOptions, useQuery } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'

type Machine = Schemas['Machine']

/**
 * The machines of the suite whose name or searchable fields contain `search`, by name, or every
 * machine without one (E2). One query for every page that needs them, so that the same list is
 * fetched and cached once.
 */
export function machinesQuery(suite: string, search = '') {
  const query = { search: search || undefined }
  return queryOptions({
    queryKey: [...queryKeys.suite(suite), 'machines', query],
    queryFn: async ({ signal }) => {
      const { items } = await unwrap(
        api.GET('/api/suites/{testsuite}/machines', {
          params: { path: { testsuite: suite }, query },
          signal,
        }),
      )
      return items
    },
  })
}

const namesOf = (machines: Machine[]) => machines.map((machine) => machine.name)

/**
 * The names of the suite's machines, fetched once for a combobox to filter locally: a suite has few
 * machines (D5), unlike commits, which a commit picker searches on the server instead (AR2).
 */
export function useMachineNames(suite: string) {
  return useQuery({ ...machinesQuery(suite), select: namesOf })
}
