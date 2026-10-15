/** The Profiles page's settings, as the URL keeps them (PF9). */

import type { Option } from '../../components/select'
import { enumParam, stringParam } from '../../url-state'
import type { ValueMode } from './instructions'

/** The two sides of the page. */
export type SideId = 'a' | 'b'

/** The ways a disassembly view can show an instruction's value (PF6), with their labels. */
export const VALUE_OPTIONS: readonly Option<ValueMode>[] = [
  { value: 'relative', label: 'Relative %' },
  { value: 'absolute', label: 'Absolute' },
  { value: 'cumulative', label: 'Cumulative %' },
]

export const PARAMS = {
  suite_a: stringParam(),
  machine_a: stringParam(),
  commit_a: stringParam(),
  run_a: stringParam(),
  test_a: stringParam(),
  /** The function shown, unless it is the side's hottest under the counter shown (PF4). */
  function_a: stringParam(),
  suite_b: stringParam(),
  machine_b: stringParam(),
  commit_b: stringParam(),
  run_b: stringParam(),
  test_b: stringParam(),
  function_b: stringParam(),
  /** The counter shown, unless it is the one the Counter dropdown starts on (PF4). */
  counter: stringParam(),
  values: enumParam(
    VALUE_OPTIONS.map((option) => option.value),
    'relative',
  ),
}

export type Settings = { [K in keyof typeof PARAMS]: (typeof PARAMS)[K]['default'] }

/** One side's settings, each `''` for none. */
export interface SideSettings {
  suite: string
  machine: string
  commit: string
  run: string
  test: string
  function: string
}

/** The settings of `side`, each from the URL parameter of that name, suffixed with the side. */
export function sideSettings(settings: Settings, side: SideId): SideSettings {
  return {
    suite: settings[`suite_${side}`],
    machine: settings[`machine_${side}`],
    commit: settings[`commit_${side}`],
    run: settings[`run_${side}`],
    test: settings[`test_${side}`],
    function: settings[`function_${side}`],
  }
}

/** The changes to the URL that give `side` the settings `changes`. */
export function sideChanges(side: SideId, changes: Partial<SideSettings>): Partial<Settings> {
  const entries = Object.entries(changes).map(([key, value]) => [`${key}_${side}`, value])
  return Object.fromEntries(entries) as Partial<Settings>
}

/** What clearing each of a side's controls also clears: the controls that depend on it (PF2). */
export const CLEARED_WITH = {
  suite: { machine: '', commit: '', run: '', test: '', function: '' },
  machine: { commit: '', run: '', test: '', function: '' },
  commit: { run: '', test: '', function: '' },
  test: { function: '' },
} as const satisfies Record<string, Partial<SideSettings>>

/**
 * `value` as the URL holds it. It is left out when it is `fallback`, which the page shows without
 * it, and when it is none (AR2 "State").
 */
export function urlValue(value: string | null | undefined, fallback: string | null | undefined) {
  return value === fallback ? '' : (value ?? '')
}
