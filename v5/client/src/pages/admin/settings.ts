/** The settings of the Admin page that live in the URL (see admin.md): the tab, and its own. */

import { sortParam, type TableSort } from '../../components/table-sort'
import { enumParam, tabSettings } from '../../url-state'

export const TABS = [
  { id: 'api-keys', label: 'API Keys' },
  { id: 'suites', label: 'Test Suites' },
] as const

export type TabId = (typeof TABS)[number]['id']

/** The columns the keys table can be sorted by, named after the API's keys (AD1). */
export const KEY_SORT_COLUMNS = [
  'prefix',
  'name',
  'scope',
  'created_at',
  'last_used_at',
  'is_active',
] as const

/** The order the API lists keys in, which the table starts with (AD1). */
const DEFAULT_KEY_SORT: TableSort = { column: 'created_at', direction: 'descending' }

export const PARAMS = {
  tab: enumParam<TabId>(
    TABS.map((tab) => tab.id),
    'api-keys',
  ),
  sort: sortParam(KEY_SORT_COLUMNS, DEFAULT_KEY_SORT),
}

/**
 * The settings each tab keeps in the URL. Another tab starts afresh, with every setting at its
 * default, and a tab drops from the URL any setting it has no use for (AR2 "State").
 */
export const { reset: resetSettings, unused: unusedSettings } = tabSettings(PARAMS, {
  'api-keys': ['sort'],
  suites: [],
})
