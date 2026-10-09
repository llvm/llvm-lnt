import { useQuery } from '@tanstack/react-query'
import { api, unwrap } from './client'
import { queryKeys } from './keys'

/** I2's largest page, so that one request is enough for any suite of reasonable size. */
const PAGE = 10_000

/** The names of every machine of the suite, by name, however many pages they take. */
async function fetchMachineNames(suite: string, signal: AbortSignal): Promise<string[]> {
  const names: string[] = []
  for (;;) {
    const page = await unwrap(
      api.GET('/api/suites/{testsuite}/machines', {
        params: { path: { testsuite: suite }, query: { limit: PAGE, offset: names.length } },
        signal,
      }),
    )
    names.push(...page.items.map((machine) => machine.name))
    if (page.items.length === 0 || names.length >= page.total) return names
  }
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
