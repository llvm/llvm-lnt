import { useId, useMemo, useState, type ReactNode } from 'react'
import { authedApi, MAX_PAGE_SIZE, unwrap, type Schemas } from '../../api/client'
import { useMachineNames } from '../../api/machines'
import { useRegressionMutation, withIndicators } from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useTestNames } from '../../api/tests'
import { useScopeGate } from '../../auth/scope'
import { DataTable, type Column } from '../../components/data-table'
import { ErrorMessage, Loading } from '../../components/feedback'
import { useRangeSelection, type RangeSelection } from '../../components/range-selection'
import { SearchInput } from '../../components/search-input'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import { Select } from '../../components/select'
import { useTextFilter } from '../../components/use-text-filter'
import { plural } from '../../format'
import { defaultMetric, metricOptions } from '../../schema'
import styles from './details.module.css'

type IndicatorObject = Schemas['IndicatorObject']

const NO_NAMES: string[] = []
const nameOf = (name: string) => name

/**
 * The panel adding indicators to the regression `uuid` (DT4): one for each machine and test
 * selected, on the metric selected. The tests offered are those with a value for the metric on any
 * of the machines selected. It is a form: nothing of it is kept in the URL.
 */
export function AddIndicators({ schema, uuid }: { schema: SuiteSchema; uuid: string }) {
  const suite = schema.name
  const triage = useScopeGate('triage')
  const [metric, setMetric] = useState(defaultMetric(schema)?.name ?? '')
  const [report, setReport] = useState<string | null>(null)

  const machineNames = useMachineNames(suite)
  const allMachines = machineNames.data ?? NO_NAMES
  const machines = useCheckboxList(allMachines, machineNames.data)
  // In the order of the list, so that the same machines ask for their tests in the same order.
  const selectedMachines = useMemo(
    () => allMachines.filter((name) => machines.selection.selected.has(name)),
    [allMachines, machines.selection.selected],
  )
  const tests = useTestNames(suite, metric === '' ? NO_NAMES : selectedMachines, metric)
  // Only a complete list shows which tests are no longer offered (AR2 "State"): until then, those
  // selected stay selected, and nothing can be added.
  const testsKnown = tests.complete && tests.error === null
  const testList = useCheckboxList(tests.names, testsKnown ? tests.names : undefined)

  // Those the list holds: while the tests are listed, some selected may not be listed yet.
  const heldTests = useMemo(() => new Set(tests.names), [tests.names])
  const selectedTests = useMemo(
    () => [...testList.selection.selected].filter((test) => heldTests.has(test)),
    [testList.selection.selected, heldTests],
  )
  const count = selectedMachines.length * selectedTests.length

  const add = useRegressionMutation(
    suite,
    uuid,
    (indicators: IndicatorObject[]) =>
      unwrap(
        authedApi.POST('/api/suites/{testsuite}/regressions/{uuid}/indicators', {
          params: { path: { testsuite: suite, uuid } },
          body: { indicators },
        }),
      ),
    withIndicators,
  )
  const submit = () => {
    // Those selected when Add is clicked: the selection may change before the answer.
    const sent = selectedMachines.flatMap((machine) =>
      selectedTests.map((test) => ({ machine, test, metric })),
    )
    setReport(null)
    add.mutate(sent, {
      onSuccess: ({ added }) => {
        const existing = sent.length - added
        setReport(
          `Added ${plural(added, 'indicator')}.` +
            (existing > 0 ? ` ${plural(existing, 'indicator')} already existed.` : ''),
        )
        testList.selection.rows.setRows(new Set(sent.map((indicator) => indicator.test)), false)
      },
    })
  }

  // Why Add is disabled, if it is.
  let why: string | undefined
  if (triage.title !== undefined) why = triage.title
  else if (metric === '') why = 'This suite has no metrics.'
  else if (!machineNames.isSuccess) why = 'The machines are not listed yet.'
  else if (!testsKnown) why = 'The tests are not listed yet.'
  else if (count === 0) why = 'Select one or more machines and tests first.'
  else if (count > MAX_PAGE_SIZE) {
    why = `One request can add at most ${MAX_PAGE_SIZE} indicators: select fewer.`
  }

  let machineStatus: ReactNode
  if (machineNames.isPending) machineStatus = <Loading label="Loading machines..." />
  else if (machineNames.isError) {
    machineStatus = (
      <ErrorMessage error={machineNames.error} onRetry={() => void machineNames.refetch()} />
    )
  } else if (machineNames.data.length === 0) machineStatus = 'This suite has no machines.'

  let testStatus: ReactNode
  if (metric === '') testStatus = 'This suite has no metrics.'
  else if (selectedMachines.length === 0) testStatus = 'Select one or more machines first.'
  else if (tests.error !== null) {
    testStatus = <ErrorMessage error={tests.error} onRetry={tests.retry} />
  } else if (!tests.complete) testStatus = <Loading label="Loading tests..." />
  else if (tests.names.length === 0) {
    testStatus = 'No test has a value for this metric on the machines selected.'
  }

  return (
    <section aria-label="Add indicators">
      <h2 className={styles.heading}>Add indicators</h2>
      {schema.metrics.length > 0 && (
        <Select
          label="Metric"
          options={metricOptions(schema)}
          value={metric}
          onChange={setMetric}
        />
      )}
      <div className={styles.lists}>
        <CheckboxList label="Machines" noun="machine" list={machines} status={machineStatus} />
        <CheckboxList label="Tests" noun="test" list={testList} status={testStatus} />
      </div>
      <div className={styles.submit}>
        <span role="status">
          This will add {plural(count, 'indicator')}
          {count > MAX_PAGE_SIZE && `, more than the ${MAX_PAGE_SIZE} one request can carry`}.
        </span>
        <button
          type="button"
          disabled={why !== undefined || add.isPending}
          title={why}
          onClick={submit}
        >
          {add.isPending ? 'Adding...' : 'Add'}
        </button>
      </div>
      {add.isError && <ErrorMessage error={add.error} />}
      {report !== null && (
        <p className={styles.report} role="status">
          {report}
        </p>
      )}
    </section>
  )
}

/** A list of names to select from, filtered locally (AR2 "Text filtering"). */
interface CheckboxListState {
  /** Every name the list holds, filtered or not. */
  names: string[]
  filter: ReturnType<typeof useTextFilter<string>>
  selection: RangeSelection
}

/**
 * `names`, filtered, with a selection among them. The filter does not change the selection: names
 * can be selected under one filter, then others under another. A name that is no longer among
 * `offered`, once that is known, is deselected.
 */
function useCheckboxList(names: string[], offered: string[] | undefined): CheckboxListState {
  const [text, setText] = useState('')
  const filter = useTextFilter(names, nameOf, text, setText)
  const selection = useRangeSelection(offered, filter.rows)
  return { names, filter, selection }
}

interface CheckboxListProps {
  /** The list's heading, and the table's accessible name. */
  label: string
  /** What the list holds, e.g. `test`. */
  noun: string
  list: CheckboxListState
  /** Shown above the list, or in its place while it has nothing to show: why. */
  status?: ReactNode
}

/**
 * A list of names with a checkbox each, filtered locally, selected one at a time or a range at a
 * time with Shift held (AR2 "Range selection"). It can hold thousands of names, such as a suite's
 * tests, so it scrolls in a box of its own.
 */
function CheckboxList({ label, noun, list, status }: CheckboxListProps) {
  const { names, filter, selection } = list
  const headingId = useId()
  const shown = filter.rows
  const { rows } = selection
  const header = `${noun[0].toUpperCase()}${noun.slice(1)}`
  // The same columns while the selection changes, so that a click renders only the checkboxes it
  // changes, rather than every row (see `SelectBox`).
  const columns = useMemo(
    (): Column<string>[] => [
      {
        id: 'name',
        header: (
          <span className={styles.checkboxLabel}>
            <SelectAllBox rows={rows} shown={shown} label={`Select all ${noun}s shown`} />
            {header}
          </span>
        ),
        cell: (name) => (
          <label className={styles.checkboxLabel}>
            <SelectBox rows={rows} rowKey={name} label={name} />
            {name}
          </label>
        ),
      },
    ],
    [rows, shown, noun, header],
  )

  // Among those selected, those the list holds, and those of them its filter hides. Counted over
  // those selected, on every click.
  const held = useMemo(() => new Set(names), [names])
  const visible = useMemo(() => new Set(shown), [shown])
  let selected = 0
  let hidden = 0
  for (const name of selection.selected) {
    if (!held.has(name)) continue
    selected++
    if (!visible.has(name)) hidden++
  }

  return (
    <div className={styles.checkboxList} role="group" aria-labelledby={headingId}>
      <h3 id={headingId} className={styles.listHeading}>
        {label}
        {names.length > 0 && (
          <span className={styles.count}>
            {' '}
            ({selected} of {plural(names.length, noun)} selected
            {hidden > 0 && `, ${hidden} hidden by the filter`})
          </span>
        )}
      </h3>
      <SearchInput
        search={filter.input}
        label={`Filter ${noun}s`}
        placeholder={`Filter ${noun}s...`}
      />
      {status !== undefined && <div className={styles.note}>{status}</div>}
      {names.length > 0 && (
        <div className={styles.scroller}>
          <DataTable
            label={label}
            columns={columns}
            rows={shown}
            rowKey={nameOf}
            empty={`No ${noun}s match the filter.`}
          />
        </div>
      )}
    </div>
  )
}
