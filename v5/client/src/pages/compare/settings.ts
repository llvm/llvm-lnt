/** The Compare page's settings, as the URL keeps them (CP7). */

import { AGGREGATIONS } from '../../aggregation'
import { sortParam } from '../../components/table-sort'
import type { NoiseKnob, NoiseSettings } from './comparison'
import { OPTIONAL_KEYS, SORTABLE } from './columns'
import {
  booleanParam,
  enumListParam,
  enumParam,
  listParam,
  optionalNumberParam,
  stringParam,
  trimmedStringParam,
} from '../../url-state'

/**
 * The two sides of the comparison, A, the baseline, and B, the new one, and the shadow (CP8): a
 * side B pinned, which the URL holds like a side.
 */
export type SideId = 'a' | 'b' | 'shadow_b'

/** At most how many hidden tests the URL holds (CP7). */
export const HIDDEN_IN_URL = 10

export const PARAMS = {
  suite_a: stringParam(),
  machine_a: stringParam(),
  commit_a: stringParam(),
  /** The runs selected, unless every run is. */
  runs_a: listParam(),
  run_agg_a: enumParam(AGGREGATIONS, 'median'),
  suite_b: stringParam(),
  machine_b: stringParam(),
  commit_b: stringParam(),
  runs_b: listParam(),
  run_agg_b: enumParam(AGGREGATIONS, 'median'),
  suite_shadow_b: stringParam(),
  machine_shadow_b: stringParam(),
  commit_shadow_b: stringParam(),
  runs_shadow_b: listParam(),
  run_agg_shadow_b: enumParam(AGGREGATIONS, 'median'),
  metric: stringParam(),
  sample_agg: enumParam(AGGREGATIONS, 'median'),
  // Each noise knob's value, present exactly while the knob is enabled (CP1).
  noise_pct: optionalNumberParam(0),
  noise_pval: optionalNumberParam(0, 1),
  noise_floor: optionalNumberParam(0),
  hide_noise: booleanParam(false),
  /** The tests hidden (CP2), while there are few enough of them to share (see `HIDDEN_IN_URL`). */
  hidden_test: listParam(),
  test_filter: trimmedStringParam(),
  test_filter_regex: booleanParam(false),
  /** The optional columns shown (CP2), in the order of `OPTIONAL_KEYS`. */
  columns: enumListParam(OPTIONAL_KEYS),
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
  runAgg: Settings['run_agg_a']
}

/** The parameter of each of a side's settings, without the suffix naming the side. */
const SIDE_PARAMS = {
  suite: 'suite',
  machine: 'machine',
  commit: 'commit',
  runs: 'runs',
  runAgg: 'run_agg',
} as const

export function sideSettings(settings: Settings, side: SideId): SideSettings {
  const entries = Object.entries(SIDE_PARAMS).map(([key, param]) => [
    key,
    settings[`${param}_${side}`],
  ])
  return Object.fromEntries(entries) as SideSettings
}

/** The changes to the URL that give `side` the settings `changes`. */
export function sideChanges(side: SideId, changes: Partial<SideSettings>): Partial<Settings> {
  const entries = Object.entries(changes).map(([key, value]) => [
    `${SIDE_PARAMS[key as keyof SideSettings]}_${side}`,
    value,
  ])
  return Object.fromEntries(entries) as Partial<Settings>
}

/** The URL parameter of each noise knob (CP7). */
export const NOISE_PARAMS = {
  pct: 'noise_pct',
  pval: 'noise_pval',
  floor: 'noise_floor',
} as const satisfies Record<NoiseKnob, keyof Settings>

/** Each noise knob's threshold, as `settings` holds it, or null while it is disabled (CP7). */
export function noiseSettings(settings: Settings): NoiseSettings {
  return {
    pct: settings[NOISE_PARAMS.pct],
    pval: settings[NOISE_PARAMS.pval],
    floor: settings[NOISE_PARAMS.floor],
  }
}

/** The changes to the URL that dismiss the shadow (CP8). */
export const NO_SHADOW: Partial<Settings> = sideChanges('shadow_b', {
  suite: '',
  machine: '',
  commit: '',
  runs: [],
  runAgg: PARAMS.run_agg_shadow_b.default,
})
