import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import {
  addIndicators,
  INDICATOR_BATCH,
  regressionChanged,
  regressionCreated,
  regressionKey,
  TEXT_LENGTH,
  withIndicators,
} from '../../api/regressions'
import { useScopeGate } from '../../auth/scope'
import { ErrorMessage } from '../../components/feedback'
import { pendingGuard } from '../../components/pending-guard'
import {
  RegressionPicker,
  UNPICKED_REGRESSION,
  type PickedRegression,
} from '../../components/regression-picker'
import { plural, shortUuid } from '../../format'
import { regressionPath } from '../../paths'
import styles from './compare.module.css'

type IndicatorObject = Schemas['IndicatorObject']

/** What was done, said beside the button until the panel is opened again. */
interface Report {
  /** What the message says before the link to the regression, and after it. */
  before: string
  after?: string
  suite: string
  regression: PickedRegression
}

interface Props {
  /** Side B's suite, machine and commit, which the regression and its indicators are of. */
  suite: string
  machine: string
  commit: string
  metric: string
  /** The tests of the compared rows with a value on side B, or undefined with no comparison. */
  tests: readonly string[] | undefined
  /** Whether the sides are swapped: the regression picked is forgotten whenever they are. */
  swapped: boolean
}

/**
 * Add to Regression (CP9): a button opening a panel that creates a regression, or adds to an
 * existing one, an indicator for each compared test with a value on side B, on side B's machine,
 * for the metric. It is a form: nothing of it is kept in the URL.
 */
export function AddToRegression({ suite, machine, commit, metric, tests, swapped }: Props) {
  const triage = useScopeGate('triage')
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<Report | null>(null)

  const create = useMutation({
    mutationFn: ({ suite: testsuite, ...body }: CreateVariables) =>
      unwrap(
        authedApi.POST('/api/suites/{testsuite}/regressions', {
          params: { path: { testsuite } },
          body,
        }),
      ),
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
  if (triage.title !== undefined) why = triage.title
  else if (tests === undefined) why = 'There is no comparison yet.'
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
  useEffect(() => {
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
          aria-expanded={open}
          disabled={pending || (!open && why !== undefined)}
          title={open ? undefined : why}
          onClick={toggle}
        >
          Add to regression
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
            key={`${suite}\0${swapped}`}
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

interface CreateVariables {
  suite: string
  title: string | null
  commit: string
  indicators: IndicatorObject[]
}

interface AddVariables {
  suite: string
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
  suite: string
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
