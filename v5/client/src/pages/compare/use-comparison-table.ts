/**
 * The Compare page's table (CP2), from the comparison's rows: the rows the test filter, the filters
 * and "Hide unchanged" and "Hide inconclusive" keep, sorted, the hidden tests, the geomean summary
 * row, and what the table says of them, with the settings the URL keeps of them (CP7).
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useRangeSelection } from '../../components/range-selection'
import type { TableSort } from '../../components/table-sort'
import { useTextFilter } from '../../components/use-text-filter'
import { compareStrings } from '../../format'
import { comparisonCsv, sortComparison, tableColumns } from './columns'
import type { TableView } from './compare-table'
import { geomeanRow, passesFilters, summaryCounts, type ComparisonRow } from './comparison'
import { confidenceOf, filterSettings, HIDDEN_IN_URL, PARAMS, type Settings } from './settings'
import type { Comparison } from './use-comparison'

const NO_TESTS: string[] = []

const testOf = (row: ComparisonRow) => row.test

/**
 * The table of `comparison`, with the page's `settings`, which `update` changes, and the Profiles
 * page of each test that has a profile on both sides, `links`.
 */
export function useComparisonTable(
  { tests, rows, biggerIsBetter }: Comparison,
  settings: Settings,
  update: (changes: Partial<Settings>) => void,
  links: ReadonlyMap<string, string>,
) {
  const filter = useTextFilter(
    rows,
    testOf,
    settings.test_filter,
    (text) => update({ test_filter: text }),
    { regex: settings.test_filter_regex },
  )
  // The rows the test filter keeps, then those of them that pass the filters (CP1): the rows the
  // summary bar counts.
  const named = filter.rows
  const { deltaPct, pValue, abs } = filterSettings(settings)
  const filtering = deltaPct !== null || pValue !== null || abs !== null
  const matching = useMemo(
    () =>
      filtering
        ? named.filter((row) => passesFilters(row, { deltaPct, pValue, abs }))
        : named,
    [named, filtering, deltaPct, pValue, abs],
  )
  // The rows the table shows: those, without the unchanged and the inconclusive ones when they are
  // hidden, which the table does not count either.
  const { hide_unchanged: hideUnchanged, hide_inconclusive: hideInconclusive } = settings
  const kept = useCallback(
    ({ status }: ComparisonRow) =>
      !(hideUnchanged && status === 'unchanged') &&
      !(hideInconclusive && status === 'inconclusive'),
    [hideUnchanged, hideInconclusive],
  )
  const shown = useMemo(() => matching.filter(kept), [matching, kept])
  const total = useMemo(() => rows.filter(kept).length, [rows, kept])
  const counts = useMemo(() => summaryCounts(matching), [matching])

  const confidence = confidenceOf(settings)
  const columns = useMemo(
    () => tableColumns(settings.columns, confidence),
    [settings.columns, confidence],
  )

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
  // and neither the test filter, the filters, nor the hide checkboxes change them.
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
  // The same, in no particular order, for the chart, which sorts them its own way: sorting the
  // table by another column leaves it as it is.
  const plotted = useMemo(
    () => shown.filter((row) => !hiddenTests.has(row.test)),
    [shown, hiddenTests],
  )
  // Whether to show the Profile column: whether any test of the comparison has a link, whatever the
  // test filter, the filters, the hide checkboxes and the hidden tests, so that the columns stay as
  // they change.
  const profiled = useMemo(
    () => allTests?.some((test) => links.has(test)) ?? false,
    [allTests, links],
  )
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
    summary:
      filter.active || filtering
        ? `${compared.length} of ${shown.length} matching tests shown · ${total} tests in total`
        : `${compared.length} of ${total} tests shown`,
    notInUrl: shared ? undefined : `The URL holds at most ${HIDDEN_IN_URL} hidden tests.`,
    geomean,
    csv,
    links,
    profiled,
    empty: emptyMessage(rows.length, named.length, matching.length, filter.active, {
      hideUnchanged,
      hideInconclusive,
    }),
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
    /** The compared rows (CP2), in no particular order: those the chart plots. */
    plotted,
  }
}

/**
 * What the table says when it has no row (CP6 "Empty states"), given how many rows the comparison
 * has, how many the test filter keeps, whether it is set, and how many of those pass the filters:
 * which of the comparison, the test filter, the filters or the hide checkboxes left none.
 */
function emptyMessage(
  all: number,
  named: number,
  matching: number,
  textFilter: boolean,
  { hideUnchanged, hideInconclusive }: { hideUnchanged: boolean; hideInconclusive: boolean },
): string {
  if (all === 0) return 'No test has a value for this metric.'
  if (named === 0) return 'No tests match the filter.'
  if (matching === 0) {
    return textFilter ? 'No matching test passes the filters.' : 'No test passes the filters.'
  }
  const hidden = [hideUnchanged && 'unchanged', hideInconclusive && 'inconclusive']
  return `Every matching test is ${hidden.filter(Boolean).join(' or ')}.`
}
