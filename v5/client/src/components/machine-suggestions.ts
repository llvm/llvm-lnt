import { useMemo } from 'react'
import { useMachineList } from '../api/machines'
import type { SuiteRef } from '../api/suites'
import type { Schemas } from '../api/client'
import { useLocalSuggestions, type Suggestion } from './suggestions'

/** The heading the untracked machines are listed under in a machine picker (AR18). */
export const UNTRACKED_SECTION = 'Untracked'

/**
 * `machines`, as listed by the API, in the order a machine picker offers them (AR18): the tracked
 * ones first, then the untracked ones, each in the API's order, which is by name.
 */
export function inPickerOrder<M extends { tracked: boolean }>(machines: readonly M[]): M[] {
  return [
    ...machines.filter((machine) => machine.tracked),
    ...machines.filter((machine) => !machine.tracked),
  ]
}

/**
 * The suggestions of a combobox picking one of `machines`, but none of `exclude` (AR18): the
 * tracked ones, then the untracked ones under their heading.
 */
export function machineSuggestions(
  machines: readonly Schemas['Machine'][],
  exclude: readonly string[] = [],
): Suggestion[] {
  return inPickerOrder(machines)
    .filter((machine) => !exclude.includes(machine.name))
    .map((machine) => ({
      key: machine.name,
      text: machine.name,
      ...(machine.tracked ? {} : { section: UNTRACKED_SECTION }),
    }))
}

/** The suite's machines, and the suggestions for a combobox that picks one of them. */
export type Machines = ReturnType<typeof useMachineSuggestions>

/**
 * The suite's machines, unless `enabled` is false, and the suggestions of a combobox picking one of
 * them, filtered locally as the user types, since a suite has few machines (D5).
 */
export function useMachineSuggestions(suite: SuiteRef, enabled = true) {
  const machines = useMachineList(suite, enabled)
  const suggestions = useLocalSuggestions(
    useMemo(() => machines.data && machineSuggestions(machines.data), [machines.data]),
    machines.error,
  )
  return { machines, suggestions }
}
