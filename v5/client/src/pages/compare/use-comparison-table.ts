/**
 * The Compare page's table (CP2), from the comparison's rows: the rows the test filter and "Hide
 * noise" keep, sorted, the hidden tests, the geomean summary row, and what the table says of them,
 * with the settings the URL keeps of them (CP7).
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useRangeSelection } from '../../components/range-selection'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings } from '../../format'
import { comparisonCsv, sortComparison, tableColumns } from './columns'
import type { TableView } from './compare-table'
import { geomeanRow, summaryCounts, type ComparisonRow } from './comparison'
import { HIDDEN_IN_URL, PARAMS, type Settings } from './settings'
import type { Comparison } from './use-comparison'

const NO_TESTS: string[] = []

const testOf = (row: ComparisonRow) => row.test

/** The table of `comparison`, with the page's `settings`, which `update` changes. */
export function useComparisonTable(
  { tests, rows, biggerIsBetter }: Comparison,
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

  const columns = useMemo(() => tableColumns(settings.columns), [settings.columns])

  // The table's rows, in the order they are sorted in, which a range selected with Shift follows.
  // A sort by a column that is not shown is the default one, and is dropped from the URL (CP7).
  // The same sort object from one render to the next, for the table not to render again.
  const usable = columns.some((entry) => entry.id === settings.sort.column)
  const { column, direction } = usable ? settings.sort : PARAMS.sort.default
  useEffect(() => {
    if (!usable) update({ sort: PARAMS.sort.default })
  }, [usable, update])
  const sort = useMemo(() => ({ column, direction }), [column, direction])
  const onSort = useCallback((next: TableSort) => update({ sort: next }), [update])
  const sorted = useMemo(() => sortComparison(shown, column, direction), [shown, column, direction])
  const sortedTests = useMemo(() => sorted.map(testOf), [sorted])

  // The hidden tests (CP2). Those the comparison no longer holds are forgotten once it is complete,
  // and neither the filter nor "Hide noise" changes them.
  const allTests = useMemo(() => tests?.map((entry) => entry.test), [tests])
  const { selected: hiddenTests, rows: hidden } = useRangeSelection(allTests, sortedTests, {
    inverted: true,
    initial: settings.hidden_test,
  })
  const compared = useMemo(
    () => sorted.filter((row) => !hiddenTests.has(row.test)),
    [sorted, hiddenTests],
  )
  const geomean = useMemo(() => geomeanRow(compared, biggerIsBetter), [compared, biggerIsBetter])
  const csv = useMemo(
    () => (compared.length === 0 ? null : () => comparisonCsv(columns, geomean, compared)),
    [columns, compared, geomean],
  )

  // The hidden tests, in the URL while there are few enough of them to share (CP7). A long list
  // from the URL stays there until the comparison is complete, which may leave few enough of them.
  const complete = tests !== undefined
  const shared = hiddenTests.size <= HIDDEN_IN_URL
  const hiddenSorted = useMemo(
    () => (shared ? [...hiddenTests].sort(compareStrings) : NO_TESTS),
    [hiddenTests, shared],
  )
  useEffect(() => {
    if (shared || complete) update({ hidden_test: hiddenSorted })
  }, [hiddenSorted, shared, complete, update])

  const view: TableView = {
    rows: sorted,
    columns,
    tests: sortedTests,
    hidden,
    summary: filter.active
      ? `${compared.length} of ${shown.length} matching tests shown (${total} total)`
      : `${compared.length} of ${total} tests shown`,
    notInUrl: shared ? undefined : `The URL holds at most ${HIDDEN_IN_URL} hidden tests.`,
    geomean,
    csv,
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
