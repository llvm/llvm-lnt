import { useCallback, useEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { authedApi, MAX_PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import { useRegressionMutation, withIndicators } from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useScopeGate, type ScopeGate } from '../../auth/scope'
import { DisabledLink } from '../../components/button-link'
import { ControlsPanel } from '../../components/controls-panel'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage } from '../../components/feedback'
import { useRangeSelection, type RowSelection } from '../../components/range-selection'
import { SearchInput } from '../../components/search-input'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import { useTextFilter } from '../../components/use-text-filter'
import { plural } from '../../format'
import { graphPath, machinePath } from '../../paths'
import { isNumeric, labelOf, type Metric } from '../../schema'
import { trimmedStringParam, useUrlState } from '../../url-state'
import styles from './details.module.css'

type Regression = Schemas['RegressionDetail']
type Indicator = Schemas['Indicator']

const PARAMS = { indicator_filter: trimmedStringParam() }

/** Why an indicator cannot be viewed on the Graph page, which plots only numeric metrics (GR1). */
const NOT_PLOTTED = 'The Graph page only plots numeric metrics.'

const indicatorKey = (indicator: Indicator) => indicator.uuid

/** A removal of indicators: their UUIDs, and where the focus goes once they are gone. */
interface Removal {
  uuids: string[]
  /** The index among `rows` of the indicator removed alone, or null for several. */
  index: number | null
  /** The rows shown when the removal was asked for. */
  rows: Indicator[]
}

/**
 * The regression's indicators (DT4), filtered locally by machine, test or metric, each of which a
 * holder of `triage` scope can remove, alone or with others selected.
 */
export function RegressionIndicators({
  schema,
  regression,
}: {
  schema: SuiteSchema
  regression: Regression
}) {
  const suite = schema.name
  const all = regression.indicators
  const triage = useScopeGate('triage')
  const [settings, update] = useUrlState(PARAMS)

  const metrics = useMemo(
    () => new Map(schema.metrics.map((metric) => [metric.name, metric])),
    [schema],
  )
  const metricLabel = useCallback(
    (name: string) => {
      const metric = metrics.get(name)
      return metric === undefined ? name : labelOf(metric)
    },
    [metrics],
  )
  // A NUL between the fields, which no name holds, so that a match never spans two of them.
  const textOf = useCallback(
    (indicator: Indicator) =>
      [indicator.machine, indicator.test, indicator.metric, metricLabel(indicator.metric)].join(
        '\u0000',
      ),
    [metricLabel],
  )
  const filter = useTextFilter(all, textOf, settings.indicator_filter, (text) =>
    update({ indicator_filter: text }),
  )
  // Without indicators, there is no filter, and so nothing for the URL to hold.
  const filterUnused = all.length === 0 && settings.indicator_filter !== ''
  useEffect(() => {
    if (filterUnused) update({ indicator_filter: '' })
  }, [filterUnused, update])

  const shown = filter.rows
  const keys = useMemo(() => shown.map(indicatorKey), [shown])
  // The filter deselects the rows it hides, so that only rows in view are ever removed.
  const selection = useRangeSelection(keys, keys)

  const table = useRef<HTMLTableElement>(null)
  const remove = useRegressionMutation(
    suite,
    regression.uuid,
    ({ uuids }: Removal) =>
      unwrap(
        authedApi.DELETE('/api/suites/{testsuite}/regressions/{uuid}/indicators', {
          params: { path: { testsuite: suite, uuid: regression.uuid } },
          body: { indicator_uuids: uuids },
        }),
      ),
    withIndicators,
  )
  // Where the focus goes once a removal shows, since the button it was on is gone: to the button
  // of the row that took the removed one's place, or of the row before it if it was the last, and
  // otherwise, or after a batch, to the table. Not before the rows have changed, and the buttons
  // are enabled again, and once per removal.
  const refocused = useRef<unknown>(null)
  const { data: removed, variables: removal, isPending: removing } = remove
  useEffect(() => {
    if (!removed || !removal || removing || refocused.current === removed) return
    if (removal.rows === shown) return
    refocused.current = removed
    const buttons = table.current?.querySelectorAll<HTMLElement>('tbody button[data-remove]')
    const at = (index: number) => buttons?.[index]
    const target = removal.index === null ? null : (at(removal.index) ?? at(removal.index - 1))
    ;(target ?? table.current)?.focus()
  }, [removed, removal, removing, shown])
  const { mutate } = remove
  // `index` is that of the row removed alone, or null for a batch.
  const removeRows = useCallback(
    (uuids: string[], index: number | null) => mutate({ uuids, index, rows: shown }),
    [mutate, shown],
  )
  const removeOne = useCallback(
    (uuid: string) => removeRows([uuid], keys.indexOf(uuid)),
    [removeRows, keys],
  )

  // The remove buttons stay enabled while a removal is under way, so that the table need not render
  // again: a second removal waits for the first (see `useRegressionMutation`), and one naming an
  // indicator already removed changes nothing (E8).
  const removeGate = useMemo(
    (): ScopeGate => ({ disabled: triage.disabled, title: triage.title }),
    [triage.disabled, triage.title],
  )
  // The same columns while the selection changes, so that a click renders only the checkboxes it
  // changes, rather than every row (see `SelectBox`).
  const columns = useMemo(
    () =>
      indicatorColumns({
        suite,
        rows: selection.rows,
        keys,
        metrics,
        metricLabel,
        removeGate,
        onRemove: removeOne,
      }),
    [suite, selection.rows, keys, metrics, metricLabel, removeGate, removeOne],
  )

  const selected = selection.selected.size
  const tooMany = selected > MAX_PAGE_SIZE
  const totals = useMemo(() => counts(all), [all])
  const title = useMemo(
    () => heading(totals, filter.active ? counts(shown) : undefined),
    [totals, shown, filter.active],
  )

  return (
    <section aria-label="Indicators">
      <h2 className={styles.heading}>{title}</h2>
      {all.length > 0 && (
        <ControlsPanel>
          <SearchInput
            search={filter.input}
            label="Filter indicators"
            placeholder="Filter by machine, test or metric..."
          />
          <button
            type="button"
            disabled={triage.disabled || remove.isPending || selected === 0 || tooMany}
            title={
              triage.title ??
              (tooMany
                ? `One request can remove at most ${MAX_PAGE_SIZE} indicators: select fewer.`
                : undefined)
            }
            onClick={() => removeRows([...selection.selected], null)}
          >
            {selected === 0 ? 'Remove selected' : `Remove ${selected} selected`}
          </button>
        </ControlsPanel>
      )}
      {remove.isError && <ErrorMessage error={remove.error} />}
      <DataTable
        ref={table}
        label="Indicators"
        columns={columns}
        rows={shown}
        rowKey={indicatorKey}
        empty={
          all.length === 0
            ? 'This regression has no indicators.'
            : 'No indicators match the filter.'
        }
      />
    </section>
  )
}

/** How many distinct tests, machines and metrics `indicators` name. */
function counts(indicators: Indicator[]) {
  const distinct = (key: 'test' | 'machine' | 'metric') =>
    new Set(indicators.map((indicator) => indicator[key])).size
  return { tests: distinct('test'), machines: distinct('machine'), metrics: distinct('metric') }
}

type Counts = ReturnType<typeof counts>

/**
 * The section's heading (DT4): how many tests, machines and metrics the indicators name, `total`,
 * and while a filter is active, how many of them the indicators it keeps name, `part`.
 */
function heading(total: Counts, part?: Counts): string {
  if (total.tests === 0) return 'Indicators'
  const of = (key: keyof Counts, noun: string) =>
    part === undefined ? plural(total[key], noun) : `${part[key]} of ${plural(total[key], noun)}`
  const counted = `${of('tests', 'test')} across ${of('machines', 'machine')} across ${of('metrics', 'metric')}`
  return part === undefined ? `Indicators (${counted})` : `Indicators (showing ${counted})`
}

interface ColumnOptions {
  suite: string
  rows: RowSelection
  /** The keys of the rows shown. */
  keys: readonly string[]
  metrics: Map<string, Metric>
  metricLabel(name: string): string
  /** Whether a remove button is enabled, and why not. */
  removeGate: ScopeGate
  onRemove(uuid: string): void
}

function indicatorColumns({
  suite,
  rows,
  keys,
  metrics,
  metricLabel,
  removeGate,
  onRemove,
}: ColumnOptions): Column<Indicator>[] {
  const describe = (indicator: Indicator) =>
    `${indicator.machine}, ${indicator.test}, ${metricLabel(indicator.metric)}`
  return [
    {
      id: 'select',
      header: <SelectAllBox rows={rows} shown={keys} label="Select all indicators shown" />,
      cell: (indicator) => (
        <SelectBox rows={rows} rowKey={indicator.uuid} label={`Select ${describe(indicator)}`} />
      ),
    },
    {
      id: 'machine',
      header: 'Machine',
      cell: (indicator) => (
        <Link to={machinePath(suite, indicator.machine)}>{indicator.machine}</Link>
      ),
    },
    { id: 'test', header: 'Test', cell: (indicator) => indicator.test },
    {
      id: 'metric',
      header: 'Metric',
      looks: ['nowrap'],
      cell: (indicator) => metricLabel(indicator.metric),
    },
    {
      id: 'graph',
      header: <VisuallyHidden>Graph</VisuallyHidden>,
      looks: ['nowrap'],
      cell: (indicator) => <GraphLink suite={suite} indicator={indicator} metrics={metrics} />,
    },
    {
      id: 'remove',
      header: <VisuallyHidden>Remove</VisuallyHidden>,
      cell: (indicator) => (
        <button
          type="button"
          className={styles.removeButton}
          data-remove
          aria-label={`Remove ${describe(indicator)}`}
          disabled={removeGate.disabled}
          title={removeGate.title ?? 'Remove this indicator'}
          onClick={() => onRemove(indicator.uuid)}
        >
          ×
        </button>
      ),
    },
  ]
}

/**
 * The indicator on the Graph page, with every state's regressions marked, so that this one's commit
 * is (GR15). The Graph page plots only numeric metrics, so for any other, the link leads nowhere,
 * and says why (AR2 "Disabled links").
 */
function GraphLink({
  suite,
  indicator,
  metrics,
}: {
  suite: string
  indicator: Indicator
  metrics: Map<string, Metric>
}) {
  const metric = metrics.get(indicator.metric)
  if (metric === undefined || !isNumeric(metric)) {
    return <DisabledLink title={NOT_PLOTTED}>View on graph</DisabledLink>
  }
  const { machine, test } = indicator
  return (
    <Link to={graphPath({ suite, machine, metric: metric.name, test, regressions: 'all' })}>
      View on graph
    </Link>
  )
}
