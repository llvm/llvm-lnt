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
export type Setting = Exclude<keyof Settings, 'tab'>

/**
 * The settings each tab keeps in the URL. Another tab starts afresh, with every setting at its
 * default, and a tab drops from the URL any setting it has no use for (AR2 "State").
 */
const TAB_SETTINGS: Record<TabId, readonly Setting[]> = {
  runs: ['search'],
  machines: ['search'],
  commits: ['search'],
  regressions: ['search', 'state', 'machine', 'metric', 'has_commit'],
}

const SETTINGS = Object.keys(PARAMS).filter((key) => key !== 'tab') as Setting[]

/** Every setting, at its default: how another tab starts. */
export function resetSettings(): Partial<Settings> {
  return defaults(SETTINGS)
}

/** The settings in the URL that the tab of `settings` has no use for, at their default. */
export function unusedSettings(settings: Settings): Partial<Settings> {
  const used = TAB_SETTINGS[settings.tab]
  const unused = SETTINGS.filter((key) => !used.includes(key))
  return defaults(unused.filter((key) => !isDefault(PARAMS[key], settings[key])))
}

function defaults(settings: readonly Setting[]): Partial<Settings> {
  return Object.fromEntries(settings.map((key) => [key, PARAMS[key].default]))
}

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
