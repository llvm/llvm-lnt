import { useMemo } from 'react'
import { useMachineLabels, useMachineList } from '../api/machines'
import type { SuiteRef } from '../api/suites'
import type { Schemas } from '../api/client'
import { compareMachines, machineLabel, type MachineNames } from '../labels'
import { useLocalSuggestions, type Suggestion } from './suggestions'

/** The heading the untracked machines are listed under in a machine picker (AR18). */
export const UNTRACKED_SECTION = 'Untracked'

/**
 * `machines` in the order a machine picker offers them (AR18): the tracked ones first, then the
 * untracked ones, each by label (AR23).
 */
export function inPickerOrder<M extends MachineNames & { tracked: boolean }>(
  machines: readonly M[],
): M[] {
  const sorted = [...machines].sort(compareMachines)
  return [
    ...sorted.filter((machine) => machine.tracked),
    ...sorted.filter((machine) => !machine.tracked),
  ]
}

/**
 * The suggestions of a combobox picking one of `machines`, but none of `exclude` (AR18): the
 * tracked ones, then the untracked ones under their heading, each shown by its label, followed by
 * its name when it has a display name, and found and picked by either (AR23).
 */
export function machineSuggestions(
  machines: readonly Schemas['Machine'][],
  exclude: readonly string[] = [],
): Suggestion[] {
  return inPickerOrder(machines)
    .filter((machine) => !exclude.includes(machine.name))
    .map((machine) => ({
      key: machine.name,
      text: machineLabel(machine),
      ...(machine.display_name === null ? {} : { aliases: [machine.name], note: machine.name }),
      ...(machine.tracked ? {} : { section: UNTRACKED_SECTION }),
    }))
}

/**
 * The suite's machines, the suggestions for a combobox that picks one of them, and their labels.
 */
export type Machines = ReturnType<typeof useMachineSuggestions>

/**
 * The suite's machines, unless `enabled` is false, the suggestions of a combobox picking one of
 * them, filtered locally as the user types, since a suite has few machines (D5), and the label of
 * each, for the text of the one picked (AR23).
 */
export function useMachineSuggestions(suite: SuiteRef, enabled = true) {
  const machines = useMachineList(suite, enabled)
  const labelOfMachine = useMachineLabels(suite, enabled)
  const suggestions = useLocalSuggestions(
    useMemo(() => machines.data && machineSuggestions(machines.data), [machines.data]),
    machines.error,
  )
  return { machines, suggestions, labelOfMachine }
}
