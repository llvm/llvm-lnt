/**
 * Helpers for a side of a suite-agnostic comparison page (CP1, PF2). They check the suite and the
 * machine that the URL names, and list the suite's machines for the side's controls (see
 * `SideFields`).
 */

import type { UseQueryResult } from '@tanstack/react-query'
import type { SuiteSchema } from '../api/suites'
import { useDropUnusable } from '../url-state'
import { hasMachine } from '../api/machines'
import { useMachineSuggestions, type Machines } from './machine-suggestions'

/**
 * Returns the side's suite schema, once `suites` shows that the suite exists, and the suite's
 * machines. When a response shows that the suite or the machine does not exist, this calls
 * `onUnusableSuite` or `onUnusableMachine`, which drop it and what depends on it (AR2 "State").
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
    (list) => machine === '' || hasMachine(list, machine),
    onUnusableMachine,
  )
  return { schema, machines }
}

/**
 * Whether to report a failed request about the side's machine. While the machine may not exist,
 * the page does not report the failure, because it is going to drop the machine (AR2 "State"). It
 * does report it when the machine list itself failed, since it cannot check the machine then.
 */
export function machineFailuresReportable(machines: Machines, machine: string): boolean {
  const { data, isError } = machines.machines
  return (data !== undefined && hasMachine(data, machine)) || isError
}

/** Whether listing the side's runs, `runs`, failed, and the page should report it. */
export function runsListFailed(
  runs: { isError: boolean },
  machines: Machines,
  machine: string,
): boolean {
  return runs.isError && machineFailuresReportable(machines, machine)
}
