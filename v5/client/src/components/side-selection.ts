/**
 * Helpers for a side of a suite-agnostic comparison page (CP1, PF2). They check the suite and the
 * machine that the URL names, and list the suite's machines for the side's controls (see
 * `SideFields`).
 */

import type { UseQueryResult } from '@tanstack/react-query'
import { findSuite, NO_SUITE, type Suite, type SuiteRef } from '../api/suites'
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
  /** The side's suite, or `NO_SUITE` if it has none. */
  suite: SuiteRef
  machine: string
  suites: UseQueryResult<Suite[]>
  onUnusableSuite: () => void
  onUnusableMachine: () => void
}): { schema: Suite | undefined; machines: Machines } {
  const schema = findSuite(suites.data, suite)
  useDropUnusable(
    suites,
    (list) => suite === NO_SUITE || findSuite(list, suite) !== undefined,
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

/**
 * The URL parameters that give a side the settings `changes`: each the parameter of the same name,
 * suffixed with the side's, `side`, but for its suite, which changes both its project's parameter
 * and its own, together (CP7, PF9).
 */
export function sideParams(
  side: string,
  changes: { suite?: SuiteRef } & Record<string, unknown>,
): Record<string, unknown> {
  const { suite, ...others } = changes
  const entries = Object.entries(others).map(([key, value]) => [`${key}_${side}`, value])
  if (suite !== undefined) {
    entries.push([`project_${side}`, suite.project], [`suite_${side}`, suite.suite])
  }
  return Object.fromEntries(entries)
}
