import { useId, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { authedApi, unwrap, type Schemas } from '../../api/client'
import { queryKeys } from '../../api/keys'
import {
  INDICATOR_BATCH,
  regressionChanged,
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
  /** What the regression picked belongs to: it is forgotten whenever this changes. */
  pickKey: string
}

/**
 * Add to Regression (CP9): a button opening a panel that creates a regression, or adds to an
 * existing one, an indicator for each compared test with a value on side B, on side B's machine,
 * for the metric. It is a form: nothing of it is kept in the URL.
 */
export function AddToRegression({ suite, machine, commit, metric, tests, pickKey }: Props) {
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
    onSuccess: async (created, { suite: testsuite }) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.regressions(testsuite),
        refetchType: 'none',
      })
      // Stored after, which leaves it fresh, for its page to show at once.
      queryClient.setQueryData(regressionKey(testsuite, created.uuid), created)
    },
  })
  const add = useMutation({
    mutationFn: ({ suite: testsuite, regression, indicators }: AddVariables) =>
      unwrap(
        authedApi.POST('/api/suites/{testsuite}/regressions/{uuid}/indicators', {
          params: { path: { testsuite, uuid: regression.uuid } },
          body: { indicators },
        }),
      ),
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

  // The indicators, as the comparison is when the button is clicked: it may change before the
  // answer.
  const indicators = (): IndicatorObject[] =>
    (tests ?? []).map((test) => ({ machine, test, metric }))
  const done = (next: Report) => {
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
          {why !== undefined && <p className={styles.note}>{why}</p>}
          <CreateForm
            disabled={why !== undefined || pending}
            creating={create.isPending}
            error={create.error}
            onCreate={onCreate}
          />
          <AddForm
            key={pickKey}
            suite={suite}
            disabled={why !== undefined || pending}
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
  creating: boolean
  error: Error | null
  onCreate(title: string): void
}

/** "Create new regression": its title, which may be left empty. */
function CreateForm({ disabled, creating, error, onCreate }: CreateFormProps) {
  const [title, setTitle] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled) onCreate(title)
  }
  return (
    <form aria-label="Create new regression" onSubmit={submit}>
      <h3 className={styles.regressionHeading}>Create new regression</h3>
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
        <button type="submit" disabled={disabled}>
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
  adding: boolean
  error: Error | null
  onAdd(regression: PickedRegression): void
}

/** "Add to existing": a regression of side B's suite, picked among them. */
function AddForm({ suite, disabled, adding, error, onAdd }: AddFormProps) {
  const [picked, setPicked] = useState<PickedRegression | null>(null)
  // The picker holds text that is not the regression picked (AR15).
  const [pickPending, setPickPending] = useState(false)
  const reasonId = useId()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!disabled && !pickPending && picked !== null) onAdd(picked)
  }
  return (
    <form aria-label="Add to existing" onSubmit={submit}>
      <h3 className={styles.regressionHeading}>Add to existing</h3>
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
          title={picked === null ? 'Pick a regression first.' : undefined}
          aria-describedby={pickPending ? reasonId : undefined}
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
