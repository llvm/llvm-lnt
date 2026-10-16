import { queryOptions, useQuery } from '@tanstack/react-query'
import { api, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'
import type { paths } from './schema'

type Machine = Schemas['Machine']

type MachineListQuery = NonNullable<
  paths['/api/suites/{testsuite}/machines']['get']['parameters']['query']
>

/**
 * The machines of the suite that `query` lists (E2): with no filter, every machine, by name. One
 * query for every page that needs them, so that the same list is fetched and cached once.
 */
export function machinesQuery(suite: string, query: MachineListQuery = {}) {
  return queryOptions({
    queryKey: [...queryKeys.machines(suite), query],
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

/** The tracked machines, most recently active first (E2), to choose some on the user's behalf. */
const RECENTLY_ACTIVE: MachineListQuery = { tracked: true, sort: '-last_run_at' }

/**
 * The names of the `count` tracked machines that most recently had a run, most recent first:
 * machines the user did not pick (D5), such as the Dashboard's (DA2). Machines without runs are
 * left out.
 */
export function useRecentlyActiveMachines(suite: string, count: number, enabled = true) {
  return useQuery({
    ...machinesQuery(suite, RECENTLY_ACTIVE),
    enabled,
    select: (machines) =>
      namesOf(machines.filter((machine) => machine.last_run_at !== null).slice(0, count)),
  })
}

/**
 * The names of the suite's machines, fetched once for a combobox to filter locally: a suite has few
 * machines (D5), unlike commits, which a commit picker searches on the server instead (AR15).
 */
export function useMachineNames(suite: string, enabled = true) {
  return useQuery({ ...machinesQuery(suite), select: namesOf, enabled })
}

/** The suite's machines, by name (E2), fetched once for the pickers to filter locally (AR18). */
export function useMachineList(suite: string, enabled = true) {
  return useQuery({ ...machinesQuery(suite), enabled })
}

/** The query key of the machine `name`, which a change to it updates. */
export function machineKey(suite: string, name: string) {
  return [...queryKeys.machines(suite), 'detail', name] as const
}

/** The machine `name` (E2). */
export function useMachine(suite: string, name: string) {
  return useQuery({
    queryKey: machineKey(suite, name),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/suites/{testsuite}/machines/{machine_name}', {
          params: { path: { testsuite: suite, machine_name: name } },
          signal,
        }),
      ),
  })
}
