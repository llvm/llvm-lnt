import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Link } from 'react-router'
import { VisuallyHidden } from 'react-aria-components'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import { useResolvedCommit, type BranchName } from '../../api/commits'
import { useMachineLabels, type MachineLabels } from '../../api/machines'
import { INDICATOR_BATCH, useRegressionMutation, withIndicators } from '../../api/regressions'
import { refOf, type Suite, type SuiteRef } from '../../api/suites'
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
import { labelAndName, machineFilterText } from '../../labels'
import { graphPath, machinePath } from '../../paths'
import { isNumeric, labelOf, type Metric } from '../../schema'
import { trimmedStringParam, useUrlState } from '../../url-state'
import styles from './details.module.css'

type Regression = Schemas['RegressionDetail']
type Indicator = Schemas['Indicator']

const PARAMS = { indicator_filter: trimmedStringParam() }

/** Why an indicator cannot be viewed on the Graph page, which plots only numeric metrics (GR1). */
const NOT_PLOTTED = 'The Graph page only plots numeric metrics.'

/** Why an indicator cannot be viewed on the Graph page yet, whose branch is not known yet (DT4). */
const LOOKING_UP = "The regression's commit is still being looked up."

const indicatorKey = (indicator: Indicator) => indicator.uuid

/** A removal of indicators: their UUIDs, and where the focus goes once they are gone. */
interface Removal {
  uuids: string[]
  /**
   * The rows whose remove button takes the focus, the first of them still shown: for an indicator
   * removed alone, those after it, then those before it, nearest first. None after a batch.
   */
  focusNext: string[]
}

/**
 * The regression's indicators (DT4), filtered locally by machine, test or metric, each of which a
 * holder of `triage` scope can remove, alone or with others selected.
 */
export function RegressionIndicators({
  schema,
  regression,
}: {
  schema: Suite
  regression: Regression
}) {
  const suite = refOf(schema)
  const all = regression.indicators
  const triage = useScopeGate('triage', suite)
  const labelOfMachine = useMachineLabels(suite)
  const [settings, update] = useUrlState(PARAMS)
  // The branch of the regression's commit, which the Graph shows it on (DT4), null for the commits
  // without a branch. Unknown, and left to the Graph's default, without a commit, or once the
  // lookup has failed or found none. While the commit is looked up, as its link at the top of the
  // page also does, the link waits for it.
  const { commit } = regression
  const resolved = useResolvedCommit(suite, commit ?? '', commit !== null)
  const lookingUp = commit !== null && resolved.isPending
  const branch: BranchName | undefined = resolved.data?.branch

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
  // A NUL between the fields, which no name or label holds, so that a match never spans two of
  // them (see `machineFilterText`).
  const textOf = useCallback(
    (indicator: Indicator) =>
      [
        machineFilterText(indicator.machine, labelOfMachine(indicator.machine)),
        indicator.test,
        indicator.metric,
        metricLabel(indicator.metric),
      ].join('\u0000'),
    [labelOfMachine, metricLabel],
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
        authedApi.DELETE('/api/projects/{project}/suites/{suite}/regressions/{uuid}/indicators', {
          params: { path: { ...suite, uuid: regression.uuid } },
          body: { indicator_uuids: uuids },
        }),
      ),
    withIndicators,
  )
  const removeSelected = useRef<HTMLButtonElement>(null)
  // Where the focus goes once a removal shows (DT4), since the button it was on may be gone: to the
  // first of `focusNext` still shown, or else to the table. Only once the removed rows are gone,
  // once per removal, and only if the focus is where the removal left it: lost, still in the table,
  // or on "Remove selected", which a browser keeps focused once the click disables it. Otherwise
  // the user has moved on, to the filter say, where a key meant for it must not press a remove
  // button.
  const refocused = useRef<unknown>(null)
  const { data: removed, variables: removal } = remove
  // In the commit, before the page is painted, so that the removal never shows without the focus
  // where it goes.
  useLayoutEffect(() => {
    if (!removed || !removal || refocused.current === removed) return
    const shownKeys = new Set(keys)
    if (removal.uuids.some((uuid) => shownKeys.has(uuid))) return
    refocused.current = removed
    const focused = document.activeElement
    const lost = focused === null || focused === document.body
    if (!lost && focused !== removeSelected.current && !table.current?.contains(focused)) return
    const next = removal.focusNext.find((uuid) => shownKeys.has(uuid))
    const button = next && table.current?.querySelector<HTMLElement>(`[data-remove="${next}"]`)
    // A table taller than the window would otherwise scroll the controls just used out of view.
    if (button) button.focus()
    else table.current?.focus({ preventScroll: true })
  }, [removed, removal, keys])
  const { mutate } = remove
  const removeOne = useCallback(
    (uuid: string) => {
      const index = keys.indexOf(uuid)
      const focusNext = [...keys.slice(index + 1), ...keys.slice(0, index).reverse()]
      mutate({ uuids: [uuid], focusNext })
    },
    [mutate, keys],
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
        branch,
        lookingUp,
        rows: selection.rows,
        keys,
        metrics,
        labelOfMachine,
        metricLabel,
        removeGate,
        onRemove: removeOne,
      }),
    [
      suite,
      branch,
      lookingUp,
      selection.rows,
      keys,
      metrics,
      labelOfMachine,
      metricLabel,
      removeGate,
      removeOne,
    ],
  )

  const selected = selection.selected.size
  const tooMany = selected > INDICATOR_BATCH
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
            ref={removeSelected}
            type="button"
            disabled={triage.disabled || remove.isPending || selected === 0 || tooMany}
            title={
              triage.title ??
              (tooMany
                ? `One request can remove at most ${INDICATOR_BATCH} indicators: select fewer.`
                : undefined)
            }
            onClick={() => mutate({ uuids: [...selection.selected], focusNext: [] })}
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
  suite: SuiteRef
  /** The branch of the regression's commit, if it is known (see `GraphLink`). */
  branch: BranchName | undefined
  /** Whether the regression's commit is still being looked up, for its branch. */
  lookingUp: boolean
  rows: RowSelection
  /** The keys of the rows shown. */
  keys: readonly string[]
  metrics: Map<string, Metric>
  labelOfMachine: MachineLabels
  metricLabel(name: string): string
  /** Whether a remove button is enabled, and why not. */
  removeGate: ScopeGate
  onRemove(uuid: string): void
}

function indicatorColumns({
  suite,
  branch,
  lookingUp,
  rows,
  keys,
  metrics,
  labelOfMachine,
  metricLabel,
  removeGate,
  onRemove,
}: ColumnOptions): Column<Indicator>[] {
  const describe = (indicator: Indicator) =>
    [
      labelAndName(indicator.machine, labelOfMachine(indicator.machine)),
      indicator.test,
      metricLabel(indicator.metric),
    ].join(', ')
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
        <Link to={machinePath(suite, indicator.machine)}>{labelOfMachine(indicator.machine)}</Link>
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
      cell: (indicator) => (
        <GraphLink
          suite={suite}
          branch={branch}
          lookingUp={lookingUp}
          indicator={indicator}
          metrics={metrics}
        />
      ),
    },
    {
      id: 'remove',
      header: <VisuallyHidden>Remove</VisuallyHidden>,
      cell: (indicator) => (
        <button
          type="button"
          className={styles.removeButton}
          data-remove={indicator.uuid}
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
 * The indicator on the Graph page, on the branch of the regression's commit, if known, and
 * otherwise on the suite's default (GR14), with every state's regressions marked, so that this
 * one's commit is (GR15). The Graph page plots only numeric metrics, so for any other, the link
 * leads nowhere, and says why (AR8), as it does while the commit is looked up.
 */
function GraphLink({
  suite,
  branch,
  lookingUp,
  indicator,
  metrics,
}: {
  suite: SuiteRef
  branch: BranchName | undefined
  lookingUp: boolean
  indicator: Indicator
  metrics: Map<string, Metric>
}) {
  const metric = metrics.get(indicator.metric)
  if (metric === undefined || !isNumeric(metric)) {
    return <DisabledLink title={NOT_PLOTTED}>View on graph</DisabledLink>
  }
  if (lookingUp) return <DisabledLink title={LOOKING_UP}>View on graph</DisabledLink>
  const { machine, test } = indicator
  const to = graphPath({
    suite,
    branch,
    machines: [machine],
    metric: metric.name,
    test,
    regressions: 'all',
  })
  return <Link to={to}>View on graph</Link>
}
