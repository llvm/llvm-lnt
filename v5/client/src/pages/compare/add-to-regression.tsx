import { useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import {
  addIndicators,
  createRegression,
  INDICATOR_BATCH,
  regressionChanged,
  regressionCreated,
  regressionKey,
  TEXT_LENGTH,
  withIndicators,
} from '../../api/regressions'
import { fullName, type Suite, type SuiteRef } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { usePickedCommitText } from '../../components/commit-lookup'
import { ErrorMessage } from '../../components/feedback'
import { pendingGuard } from '../../components/pending-guard'
import {
  RegressionPicker,
  UNPICKED_REGRESSION,
  type PickedRegression,
} from '../../components/regression-picker'
import { plural, shortUuid } from '../../format'
import { fullLabel } from '../../labels'
import { regressionPath } from '../../paths'
import type { ComparisonRow } from './comparison'
import styles from './compare.module.css'

type IndicatorObject = Schemas['IndicatorObject']

/** What was done, said beside the button until the panel is opened again. */
interface Report {
  /** What the message says before the link to the regression, and after it. */
  before: string
  after?: string
  suite: SuiteRef
  regression: PickedRegression
}

interface Props {
  /** Side B's suite, machine and commit, which the regression and its indicators are of. */
  suite: SuiteRef
  /** Side B's suite, once the suites are known to hold it, which shows its commit (AR6). */
  schema: Suite | undefined
  machine: string
  commit: string
  metric: string
  /** How the metric is labelled (AR6). */
  metricLabel: string
  /** The compared rows (CP2), in no particular order, or undefined with no comparison. */
  rows: readonly ComparisonRow[] | undefined
  /** Whether the sides are swapped: the regression picked is forgotten whenever they are. */
  swapped: boolean
}

/**
 * Add to Regression (CP9): a box of its own, which its header expands, that creates a regression,
 * or adds to an existing one, an indicator for each compared test with a value on side B, on side
 * B's machine, for the metric, and says so. It is a form: nothing of it is kept in the URL.
 */
export function AddToRegression({
  suite,
  schema,
  machine,
  commit,
  metric,
  metricLabel,
  rows,
  swapped,
}: Props) {
  const triage = useScopeGate('triage', suite)
  // The tests made indicators of: those of the rows with a value on side B, whose suite may not
  // even have the others' tests. In no particular order, so that sorting the table changes nothing.
  const tests = useMemo(
    () => rows?.filter((row) => row.b !== null).map((row) => row.test),
    [rows],
  )
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<Report | null>(null)

  const create = useMutation({
    mutationFn: ({ suite: testsuite, ...body }: CreateVariables) =>
      createRegression(testsuite, body),
    onSuccess: (created, { suite: testsuite }) =>
      regressionCreated(queryClient, testsuite, created),
  })
  const add = useMutation({
    mutationFn: ({ suite: testsuite, regression, indicators }: AddVariables) =>
      addIndicators(testsuite, regression.uuid, indicators),
    // A fetch of the regression under way could land after the answer, and show it as it was.
    onMutate: ({ suite: testsuite, regression }) =>
      queryClient.cancelQueries({ queryKey: regressionKey(testsuite, regression.uuid) }),
    onSuccess: (result, { suite: testsuite, regression }) =>
      regressionChanged(queryClient, testsuite, regression.uuid, (stored) =>
        withIndicators(result, stored),
      ),
  })
  const pending = create.isPending || add.isPending

  // Why nothing can be added, if nothing can.
  let why: string | undefined
  // Before the scope, which side B's suite cannot be named for until there is a comparison.
  if (tests === undefined) why = 'There is no comparison yet.'
  else if (triage.title !== undefined) why = triage.title
  else if (tests.length === 0) why = 'No compared test has a value on side B.'
  else if (tests.length > INDICATOR_BATCH) {
    why = `One request can add at most ${plural(INDICATOR_BATCH, 'indicator')}: hide some tests.`
  }

  const blocked = why !== undefined || pending
  const whyId = useId()

  // The indicators, as the comparison is when the button is clicked: it may change before the
  // answer.
  const indicators = (): IndicatorObject[] =>
    (tests ?? []).map((test) => ({ machine, test, metric }))
  // Once done, the form the button was clicked in is gone: the focus goes back to the toggle.
  const toggleRef = useRef<HTMLButtonElement>(null)
  const finished = useRef(false)
  // In the commit, before the page is painted, so that the report never shows without the focus on
  // the toggle.
  useLayoutEffect(() => {
    if (open || !finished.current) return
    finished.current = false
    toggleRef.current?.focus()
  }, [open])
  const done = (next: Report) => {
    finished.current = true
    setOpen(false)
    setReport(next)
  }
  const onCreate = (title: string) => {
    create.mutate(
      { suite, title: title.trim() || null, commit, indicators: indicators() },
      {
        onSuccess: ({ uuid, title: created }) =>
          done({ before: 'Regression created: ', suite, regression: { uuid, title: created } }),
      },
    )
  }
  const onAdd = (regression: PickedRegression) => {
    const sent = indicators()
    add.mutate(
      { suite, regression, indicators: sent },
      {
        onSuccess: ({ added }) => {
          const existing = sent.length - added
          done({
            before: `Added ${plural(added, 'indicator')} to `,
            after: existing > 0 ? `. ${plural(existing, 'indicator')} already existed.` : '.',
            suite,
            regression,
          })
        },
      },
    )
  }
  const toggle = () => {
    if (!open) {
      setReport(null)
      create.reset()
      add.reset()
    }
    setOpen(!open)
  }

  return (
    <div className={styles.addToRegression}>
      <div className={styles.addRow}>
        {/* An open panel can always be closed, but not while a request is under way, whose answer
            it shows. */}
        <button
          ref={toggleRef}
          type="button"
          className={styles.disclosure}
          aria-expanded={open}
          disabled={pending || (!open && why !== undefined)}
          title={open ? undefined : why}
          onClick={toggle}
        >
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Add to regression
        </button>
        {report !== null && (
          <span role="status">
            {report.before}
            <Link to={regressionPath(report.suite, report.regression.uuid)}>
              {report.regression.title ?? shortUuid(report.regression.uuid)}
            </Link>
            {report.after}
          </span>
        )}
      </div>
      {open && (
        <div className={styles.regressionPanel}>
          {schema !== undefined && tests !== undefined && tests.length > 0 && (
            <Summary
              schema={schema}
              machine={machine}
              commit={commit}
              metric={metricLabel}
              tests={tests.length}
              skipped={(rows?.length ?? 0) - tests.length}
            />
          )}
          {why !== undefined && (
            <p id={whyId} className={styles.note}>
              {why}
            </p>
          )}
          <CreateForm
            disabled={blocked}
            why={why === undefined ? undefined : whyId}
            creating={create.isPending}
            error={create.error}
            onCreate={onCreate}
          />
          {/* The regression picked is one of side B's suite, as the sides were. */}
          <AddForm
            key={`${fullName(suite)}\0${swapped}`}
            suite={suite}
            disabled={blocked}
            why={why === undefined ? undefined : whyId}
            adding={add.isPending}
            error={add.error}
            onAdd={onAdd}
          />
        </div>
      )}
    </div>
  )
}

interface SummaryProps {
  schema: Suite
  machine: string
  commit: string
  metric: string
  /** How many indicators there are, and how many compared tests are left out of them. */
  tests: number
  skipped: number
}

/**
 * What the indicators are, and which commit a new regression is attributed to (CP9): side B's,
 * by its display value once known, which its picker has looked up already (AR15).
 */
function Summary({ schema, machine, commit, metric, tests, skipped }: SummaryProps) {
  const shown = usePickedCommitText(schema, { machine }, commit)
  const rows: [string, string][] = [
    ['Covers', plural(tests, 'selected test')],
    ['Test Suite', fullLabel(schema)],
    ['Metric', metric],
    ['Machine', machine],
    ['Commit', shown],
  ]
  return (
    <div className={styles.regressionSummary}>
      <dl className={styles.regressionTargets}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.regressionTarget}>
            <dt>{label}:</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {skipped > 0 && (
        <p className={styles.note}>
          {skipped === 1
            ? '1 test compared has no value on side B, and is left out.'
            : `${skipped} tests compared have no value on side B, and are left out.`}
        </p>
      )}
    </div>
  )
}

interface CreateVariables {
  suite: SuiteRef
  title: string | null
  commit: string
  indicators: IndicatorObject[]
}

interface AddVariables {
  suite: SuiteRef
  regression: PickedRegression
  indicators: IndicatorObject[]
}

interface CreateFormProps {
  disabled: boolean
  /** The id of what says why nothing can be added, while nothing can. */
  why: string | undefined
  creating: boolean
  error: Error | null
  onCreate(title: string): void
}

/** "Create new regression": its title, which may be left empty. */
function CreateForm({ disabled, why, creating, error, onCreate }: CreateFormProps) {
  const [title, setTitle] = useState('')
  const headingId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled) onCreate(title)
  }
  return (
    <form aria-labelledby={headingId} onSubmit={submit}>
      <h3 id={headingId} className={styles.regressionHeading}>
        Create new regression
      </h3>
      <div className={styles.regressionFields}>
        <label className={styles.regressionField}>
          Title
          <input
            type="text"
            value={title}
            maxLength={TEXT_LENGTH}
            placeholder="Untitled"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button type="submit" disabled={disabled} aria-describedby={why}>
          {creating ? 'Creating...' : 'Create regression'}
        </button>
      </div>
      {error !== null && <ErrorMessage error={error} />}
    </form>
  )
}

interface AddFormProps {
  suite: SuiteRef
  disabled: boolean
  /** The id of what says why nothing can be added, while nothing can. */
  why: string | undefined
  adding: boolean
  error: Error | null
  onAdd(regression: PickedRegression): void
}

/** "Add to existing": a regression of side B's suite, picked among them. */
function AddForm({ suite, disabled, why, adding, error, onAdd }: AddFormProps) {
  const [picked, setPicked] = useState<PickedRegression | null>(null)
  // The picker holds text that is not the regression picked (AR15).
  const [pickPending, setPickPending] = useState(false)
  const reasonId = useId()
  const headingId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && !pickPending && picked !== null) onAdd(picked)
  }
  return (
    <form aria-labelledby={headingId} onSubmit={submit}>
      <h3 id={headingId} className={styles.regressionHeading}>
        Add to existing
      </h3>
      <div className={styles.regressionFields}>
        <RegressionPicker
          label="Regression"
          suite={suite}
          value={picked}
          onChange={setPicked}
          onPendingChange={setPickPending}
          placeholder="Search regressions..."
          isDisabled={disabled}
        />
        <button
          type="submit"
          disabled={disabled || picked === null}
          title={why === undefined && picked === null ? 'Pick a regression first.' : undefined}
          aria-describedby={pickPending ? reasonId : why}
          {...pendingGuard(pickPending)}
        >
          {adding ? 'Adding...' : 'Add indicators'}
        </button>
      </div>
      {pickPending && (
        <p id={reasonId} className={styles.note}>
          {UNPICKED_REGRESSION}
        </p>
      )}
      {error !== null && <ErrorMessage error={error} />}
    </form>
  )
}
