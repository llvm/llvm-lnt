/**
 * How a side of a suite-agnostic comparison page (CP1, PF2) checks the suite and the machine the URL
 * names, and lists the suite's machines, for its controls (see `SideFields`).
 */

import type { UseQueryResult } from '@tanstack/react-query'
import type { SuiteSchema } from '../api/suites'
import { useDropUnusable } from '../url-state'
import { useMachineSuggestions, type Machines } from './machine-suggestions'

/**
 * The side's suite, once the suites `suites` lists are known to hold it, and its machines. Once a
 * response shows that the suite, or the machine, does not exist, `onUnusableSuite` or
 * `onUnusableMachine` is called to drop it, along with what depends on it (AR2 "State").
 */
export function useSuiteAndMachine({
  suite,
  machine,
  suites,
  onUnusableSuite,
  onUnusableMachine,
}: {
  suite: string
  machine: string
  suites: UseQueryResult<SuiteSchema[]>
  onUnusableSuite: () => void
  onUnusableMachine: () => void
}): { schema: SuiteSchema | undefined; machines: Machines } {
  const schema = suites.data?.find((entry) => entry.name === suite)
  useDropUnusable(
    suites,
    (list) => suite === '' || list.some((entry) => entry.name === suite),
    onUnusableSuite,
  )
  const machines = useMachineSuggestions(suite, schema !== undefined)
  useDropUnusable(
    machines.machines,
    (names) => machine === '' || names.includes(machine),
    onUnusableMachine,
  )
  return { schema, machines }
}

/**
 * Whether to say that a request about the side's machine failed: not while the machine may not
 * exist, since no error is reported for a value that turns out to be unusable (AR2 "State"), unless
 * its existence cannot be checked.
 */
export function machineFailuresReportable(machines: Machines, machine: string): boolean {
  return (machines.machines.data?.includes(machine) ?? false) || machines.machines.isError
}

/** Whether the side's runs, `runs`, could not be listed, and that is to be said. */
export function runsListFailed(
  runs: { isError: boolean },
  machines: Machines,
  machine: string,
): boolean {
  return runs.isError && machineFailuresReportable(machines, machine)
}
