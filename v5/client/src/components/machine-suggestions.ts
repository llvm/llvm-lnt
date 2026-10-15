import { useMemo } from 'react'
import { useMachineNames } from '../api/machines'
import { useLocalSuggestions } from './suggestions'

/** The suite's machines, and the suggestions of a combobox picking one (see `useMachineSuggestions`). */
export type Machines = ReturnType<typeof useMachineSuggestions>

/**
 * The names of the suite's machines, unless `enabled` is false, and the suggestions of a combobox
 * picking one of them, filtered locally as the user types, since a suite has few machines (D5).
 */
export function useMachineSuggestions(suite: string, enabled = true) {
  const machines = useMachineNames(suite, enabled)
  const suggestions = useLocalSuggestions(
    useMemo(() => machines.data?.map((name) => ({ key: name, text: name })), [machines.data]),
    machines.error,
  )
  return { machines, suggestions }
}
