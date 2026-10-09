/** The states of a regression (E8), as the UI presents them. */

import type { Schemas } from './api/client'

export type RegressionState = Schemas['RegressionStateName']

/** Every state (E8), in the order the UI lists them: those still being worked on first. */
export const REGRESSION_STATES: readonly RegressionState[] = [
  'detected',
  'active',
  'not_to_be_fixed',
  'fixed',
  'false_positive',
]

/** How a state is shown: its name, in words. */
export function stateLabel(state: RegressionState): string {
  return state.replaceAll('_', ' ')
}
