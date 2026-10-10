/**
 * The settings of the Test Suites page that live in the URL (TS1): the tab, and those of each tab.
 */

import { suitePath } from '../../paths'
import { REGRESSION_STATES } from '../../regression-states'
import {
  booleanParam,
  enumListParam,
  enumParam,
  isDefault,
  stringParam,
  tabSettings,
  trimmedStringParam,
  type ValuesOf,
} from '../../url-state'

export const TABS = [
  { id: 'runs', label: 'Runs' },
  { id: 'machines', label: 'Machines' },
  { id: 'commits', label: 'Commits' },
  { id: 'regressions', label: 'Regressions' },
] as const

export type TabId = (typeof TABS)[number]['id']

/** The Regressions tab's filters, besides the search every tab has. */
export const REGRESSION_PARAMS = {
  state: enumListParam(REGRESSION_STATES),
  machine: stringParam(),
  metric: stringParam(),
  // "No commit set" is `has_commit=false`, as the API spells it.
  has_commit: booleanParam(true),
}

export type RegressionFilters = ValuesOf<typeof REGRESSION_PARAMS>

/** Whether any of `filters` narrows the list of regressions. */
export function isFiltered(filters: RegressionFilters): boolean {
  const keys = Object.keys(REGRESSION_PARAMS) as (keyof RegressionFilters)[]
  return keys.some((key) => !isDefault<unknown>(REGRESSION_PARAMS[key], filters[key]))
}

export const PARAMS = {
  tab: enumParam<TabId>(
    TABS.map((tab) => tab.id),
    'runs',
  ),
  search: trimmedStringParam(),
  ...REGRESSION_PARAMS,
}

export type Settings = ValuesOf<typeof PARAMS>

/**
 * The settings each tab keeps in the URL. Another tab starts afresh, with every setting at its
 * default, and a tab drops from the URL any setting it has no use for (AR2 "State").
 */
export const { reset: resetSettings, unused: unusedSettings } = tabSettings(PARAMS, {
  runs: ['search'],
  machines: ['search'],
  commits: ['search'],
  regressions: ['search', 'state', 'machine', 'metric', 'has_commit'],
})

/**
 * The path of `tab` of the page for `suite`, with the Regressions tab filtered by `filters`: what
 * another page links to. Settings at their default are left out, as the page leaves them out.
 */
export function suiteTabPath(suite: string, tab: Exclude<TabId, 'regressions'>): string
export function suiteTabPath(
  suite: string,
  tab: 'regressions',
  filters?: Pick<Partial<RegressionFilters>, 'machine'>,
): string
export function suiteTabPath(
  suite: string,
  tab: TabId,
  filters: Pick<Partial<RegressionFilters>, 'machine'> = {},
): string {
  const search = new URLSearchParams()
  if (tab !== PARAMS.tab.default) search.set('tab', tab)
  if (filters.machine) search.set('machine', filters.machine)
  const query = search.toString()
  return query ? `${suitePath(suite)}?${query}` : suitePath(suite)
}
