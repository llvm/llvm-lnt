/**
 * The Compare page's table (CP2), from the comparison's rows: the rows the test filter and "Hide
 * noise" keep, sorted, the geomean summary row, and what the table says of them, with the settings the URL
 * keeps of them (CP7).
 */

import { useCallback, useMemo } from 'react'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { COLUMNS, sortComparison } from './columns'
import type { TableView } from './compare-table'
import { geomeanRow, summaryCounts, type ComparisonRow } from './comparison'
import type { Settings } from './settings'
import type { Comparison } from './use-comparison'

const testOf = (row: ComparisonRow) => row.test

/** The table of `comparison`, with the page's `settings`, which `update` changes. */
export function useComparisonTable(
  { rows, biggerIsBetter }: Comparison,
  settings: Settings,
  update: (changes: Partial<Settings>) => void,
) {
  const filter = useTextFilter(
    rows,
    testOf,
    settings.test_filter,
    (text) => update({ test_filter: text }),
    { regex: settings.test_filter_regex },
  )
  const matching = filter.rows
  // The rows the table shows: those the filter keeps, without the noise when it is hidden.
  const shown = useMemo(
    () => (settings.hide_noise ? matching.filter((row) => row.status !== 'noise') : matching),
    [matching, settings.hide_noise],
  )
  const total = useMemo(
    () =>
      settings.hide_noise ? rows.filter((row) => row.status !== 'noise').length : rows.length,
    [rows, settings.hide_noise],
  )
  const counts = useMemo(() => summaryCounts(matching), [matching])

  // The same sort object from one render to the next, for the table not to render again.
  const { column, direction } = settings.sort
  const sort = useMemo(() => ({ column, direction }), [column, direction])
  const onSort = useCallback((next: TableSort) => update({ sort: next }), [update])
  const sorted = useMemo(() => sortComparison(shown, column, direction), [shown, column, direction])
  const geomean = useMemo(() => geomeanRow(shown, biggerIsBetter), [shown, biggerIsBetter])

  const view: TableView = {
    rows: sorted,
    columns: COLUMNS,
    summary: filter.active
      ? `${shown.length} of ${shown.length} matching tests shown (${total} total)`
      : `${shown.length} of ${total} tests shown`,
    geomean,
    empty:
      rows.length === 0
        ? 'No test has a value for this metric.'
        : matching.length === 0
          ? 'No tests match the filter.'
          : 'Every matching test is classified as noise.',
    sort,
    onSort,
  }
  return {
    /** What the table shows. */
    view,
    /** The test filter, which its input drives. */
    filter,
    /** How many of the tests the filter keeps fall in each category of the summary bar (CP4). */
    counts,
  }
}
