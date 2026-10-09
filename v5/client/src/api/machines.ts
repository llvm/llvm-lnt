import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import { queryKeys } from './keys'
import type { paths } from './schema'

type MachineListQuery = NonNullable<
  paths['/api/suites/{testsuite}/machines']['get']['parameters']['query']
>

/** Every machine of `GET /machines` (E2) that `query` matches, by name unless it sorts otherwise. */
export async function fetchMachines(suite: string, query: MachineListQuery, signal?: AbortSignal) {
  const { items } = await unwrap(
    api.GET('/api/suites/{testsuite}/machines', {
      params: { path: { testsuite: suite }, query },
      signal,
    }),
  )
  return items
}

/** The names of every machine of the suite, by name. */
async function fetchMachineNames(suite: string, signal: AbortSignal): Promise<string[]> {
  const machines = await fetchMachines(suite, {}, signal)
  return machines.map((machine) => machine.name)
}

/**
 * The names of the suite's machines, fetched once for a combobox to filter locally: a suite has few
 * machines (D5), unlike commits, which a commit picker searches on the server instead (AR2).
 */
export function useMachineNames(suite: string) {
  return useQuery({
    queryKey: [...queryKeys.suite(suite), 'machines', 'names'],
    queryFn: ({ signal }) => fetchMachineNames(suite, signal),
  })
}
