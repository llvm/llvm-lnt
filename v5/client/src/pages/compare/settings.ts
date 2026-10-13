/** The Compare page's settings, as the URL keeps them (CP7). */

import { AGGREGATIONS } from '../../aggregation'
import { sortParam } from '../../components/table-sort'
import { SORTABLE } from './columns'
import {
  booleanParam,
  enumParam,
  listParam,
  stringParam,
  trimmedStringParam,
} from '../../url-state'

/** The two sides of the comparison: A, the baseline, and B, the new one. */
export type SideId = 'a' | 'b'

export const PARAMS = {
  suite_a: stringParam(),
  machine_a: stringParam(),
  commit_a: stringParam(),
  /** The runs selected, unless every run is. */
  runs_a: listParam(),
  suite_b: stringParam(),
  machine_b: stringParam(),
  commit_b: stringParam(),
  runs_b: listParam(),
  metric: stringParam(),
  // How both sides' runs are combined, and the samples within each run (CP1).
  run_agg: enumParam(AGGREGATIONS, 'median'),
  sample_agg: enumParam(AGGREGATIONS, 'median'),
  test_filter: trimmedStringParam(),
  test_filter_regex: booleanParam(false),
  // Delta % descending by default (CP2).
  sort: sortParam(SORTABLE, { column: 'delta_pct', direction: 'descending' }),
}

export type Settings = { [K in keyof typeof PARAMS]: (typeof PARAMS)[K]['default'] }

/** One side's settings. */
export interface SideSettings {
  suite: string
  machine: string
  commit: string
  runs: string[]
}

/** The settings of `side`, each the URL's parameter of the same name, suffixed with the side's. */
export function sideSettings(settings: Settings, side: SideId): SideSettings {
  return {
    suite: settings[`suite_${side}`],
    machine: settings[`machine_${side}`],
    commit: settings[`commit_${side}`],
    runs: settings[`runs_${side}`],
  }
}

/** What clearing each of a side's controls clears with it (CP1): what depends on it. */
export const CLEARED_WITH = {
  suite: { machine: '', commit: '', runs: [] },
  machine: { commit: '', runs: [] },
  commit: { runs: [] },
} as const satisfies Record<string, Partial<SideSettings>>

/** The changes to the URL that give `side` the settings `changes`. */
export function sideChanges(side: SideId, changes: Partial<SideSettings>): Partial<Settings> {
  const entries = Object.entries(changes).map(([key, value]) => [`${key}_${side}`, value])
  return Object.fromEntries(entries) as Partial<Settings>
}
