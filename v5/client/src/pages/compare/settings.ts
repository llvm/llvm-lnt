/** The Compare page's settings, as the URL keeps them (CP7). */

import { AGGREGATIONS, DEFAULT_AGGREGATION } from '../../aggregation'
import { suiteRef, type SuiteRef } from '../../api/suites'
import { sideParams } from '../../components/side-selection'
import { sortParam } from '../../components/table-sort'
import type { FilterKey, Filters } from './comparison'
import { OPTIONAL_KEYS, SORTABLE } from './columns'
import { shadowParam } from './shadow-specs'
import {
  booleanParam,
  enumListParam,
  enumParam,
  listParam,
  numberParam,
  optionalNumberParam,
  stringParam,
  trimmedStringParam,
} from '../../url-state'

/** The two sides of the comparison, A, the baseline, and B, the new one. */
export type SideId = 'a' | 'b'

/** The confidence levels offered (CP1), as percentages. */
export const CONFIDENCES = ['80', '90', '95', '99'] as const

/** At most how many hidden tests the URL holds (CP7). */
export const HIDDEN_IN_URL = 10

export const PARAMS = {
  // A side's suite, by its project's name and its own (AR22), which go together.
  project_a: stringParam(),
  suite_a: stringParam(),
  machine_a: stringParam(),
  commit_a: stringParam(),
  /** The runs selected, unless every run is. */
  runs_a: listParam(),
  project_b: stringParam(),
  suite_b: stringParam(),
  machine_b: stringParam(),
  commit_b: stringParam(),
  runs_b: listParam(),
  /** The shadows (CP8), each a side B pinned, in the order they were pinned. */
  shadow: shadowParam(),
  metric: stringParam(),
  // How both sides' runs, and the shadows', are combined, and the samples within each run (CP1).
  run_agg: enumParam(AGGREGATIONS, DEFAULT_AGGREGATION),
  sample_agg: enumParam(AGGREGATIONS, DEFAULT_AGGREGATION),
  // How the tests are classified (CP1): the margin, as a percentage, and the confidence level.
  margin: numberParam(5, 0),
  confidence: enumParam(CONFIDENCES, '90'),
  // Each filter's threshold, present exactly while the filter is enabled (CP1).
  min_delta_pct: optionalNumberParam(0),
  max_pvalue: optionalNumberParam(0, 1),
  min_abs: optionalNumberParam(0),
  hide_unchanged: booleanParam(false),
  hide_inconclusive: booleanParam(false),
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
  /** The side's suite, or `NO_SUITE` for none. */
  suite: SuiteRef
  machine: string
  commit: string
  runs: string[]
}

/**
 * The settings of `side`, each the URL's parameter of the same name, suffixed with the side's, but
 * for its suite, which is also its project's (see `sideChanges`).
 */
export function sideSettings(settings: Settings, side: SideId): SideSettings {
  return {
    suite: suiteRef(settings[`project_${side}`], settings[`suite_${side}`]),
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

/** The changes to the URL that give `side` the settings `changes` (see `sideParams`). */
export function sideChanges(side: SideId, changes: Partial<SideSettings>): Partial<Settings> {
  return sideParams(side, changes) as Partial<Settings>
}

/** The confidence level `settings` holds, as a percentage (CP1). */
export function confidenceOf(settings: Pick<Settings, 'confidence'>): number {
  return Number(settings.confidence)
}

/** The URL parameter of each filter (CP7). */
export const FILTER_PARAMS = {
  deltaPct: 'min_delta_pct',
  pValue: 'max_pvalue',
  abs: 'min_abs',
} as const satisfies Record<FilterKey, keyof Settings>

/**
 * The filters that apply (CP1): those `filters` enables, but for P-value at most unless `pValues`,
 * which says whether both sides have the selected runs a p-value needs.
 */
export function appliedFilters(filters: Filters, pValues: boolean): Filters {
  return pValues ? filters : { ...filters, pValue: null }
}

/** Each filter's threshold, as `settings` holds it, or null while it is disabled (CP7). */
export function filterSettings(
  settings: Pick<Settings, (typeof FILTER_PARAMS)[FilterKey]>,
): Filters {
  return {
    deltaPct: settings[FILTER_PARAMS.deltaPct],
    pValue: settings[FILTER_PARAMS.pValue],
    abs: settings[FILTER_PARAMS.abs],
  }
}
