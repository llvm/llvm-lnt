import { useMemo } from 'react'
import { queryOptions, useQuery } from '@tanstack/react-query'
import { machineLabel } from '../labels'
import { api, unwrap, type Schemas } from './client'
import { queryKeys } from './keys'
import type { paths } from './schema'
import type { SuiteRef } from './suites'

type Machine = Schemas['Machine']

/** The longest name a machine can have (D5's column). */
export const MACHINE_NAME_LENGTH = 256

/** The longest display name a machine can have (D5). */
export const DISPLAY_NAME_LENGTH = 256

type MachineListQuery = NonNullable<
  paths['/api/projects/{project}/suites/{suite}/machines']['get']['parameters']['query']
>

/**
 * The machines of the suite that `query` lists (E2): with no filter, every machine, by name. One
 * query for every page that needs them, so that the same list is fetched and cached once.
 */
export function machinesQuery(suite: SuiteRef, query: MachineListQuery = {}) {
  return queryOptions({
    queryKey: [...queryKeys.machines(suite), query],
    queryFn: async ({ signal }) => {
      const { items } = await unwrap(
        api.GET('/api/projects/{project}/suites/{suite}/machines', {
          params: { path: suite, query },
          signal,
        }),
      )
      return items
    },
  })
}

/** Whether `machines`, as the API listed them, include the machine `name`. */
export function hasMachine(machines: readonly Machine[], name: string): boolean {
  return machines.some((machine) => machine.name === name)
}

/** The tracked machines, most recently active first (E2), to choose some on the user's behalf. */
const RECENTLY_ACTIVE: MachineListQuery = { tracked: true, sort: '-last_run_at' }

/**
 * The `count` tracked machines that most recently had a run, most recent first: machines the user
 * did not pick (D5), such as the Dashboard's (DA2). Machines without runs are left out.
 */
export function useRecentlyActiveMachines(suite: SuiteRef, count: number, enabled = true) {
  return useQuery({
    ...machinesQuery(suite, RECENTLY_ACTIVE),
    enabled,
    select: (machines) =>
      machines.filter((machine) => machine.last_run_at !== null).slice(0, count),
  })
}

/**
 * The suite's machines, by name (E2), fetched once for a picker to filter locally (AR18): a suite
 * has few machines (D5), unlike commits, which a commit picker searches on the server (AR15).
 */
export function useMachineList(suite: SuiteRef, enabled = true) {
  return useQuery({ ...machinesQuery(suite), enabled })
}

/** The label of the machine a name names (AR23). */
export type MachineLabels = (name: string) => string

// A plain object rather than a Map, so that the query keeps it, and the lookup below, the same
// from one fetch of the machines to the next while no label changes.
const labelsByName = (machines: readonly Machine[]): Record<string, string> =>
  Object.fromEntries(machines.map((machine) => [machine.name, machineLabel(machine)]))

/** The lookup of `labels`, which names a machine they do not hold, if any, by its name. */
function lookup(labels: Record<string, string> | undefined): MachineLabels {
  return (name) => (labels !== undefined && Object.hasOwn(labels, name) ? labels[name] : name)
}

/**
 * The label of each of the suite's machines, by name (AR23), for what refers to a machine by its
 * name alone, such as a run (I4). A machine is named by its name while the suite's machines are
 * being fetched, if they cannot be, or if they do not include it: nothing waits for them, and
 * their failure is not reported, since the name still names the machine.
 */
export function useMachineLabels(suite: SuiteRef, enabled = true): MachineLabels {
  const { data } = useQuery({ ...machinesQuery(suite), enabled, select: labelsByName })
  return useMemo(() => lookup(data), [data])
}

/** The query key of the machine `name`, which a change to it updates. */
export function machineKey(suite: SuiteRef, name: string) {
  return [...queryKeys.machines(suite), 'detail', name] as const
}

/** The machine `name` (E2), unless `enabled` is false. */
export function useMachine(suite: SuiteRef, name: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: machineKey(suite, name),
    queryFn: ({ signal }) =>
      unwrap(
        api.GET('/api/projects/{project}/suites/{suite}/machines/{machine_name}', {
          params: { path: { ...suite, machine_name: name } },
          signal,
        }),
      ),
  })
}
