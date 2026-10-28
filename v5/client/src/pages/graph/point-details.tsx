import { useRef, useState, type FormEvent, type RefObject } from 'react'
import { Link } from 'react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { linkedAggregation, type Aggregation } from '../../aggregation'
import {
  createRegression,
  refetchMarkedRegressions,
  regressionCreated,
  TEXT_LENGTH,
} from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { useScopeGate } from '../../auth/scope'
import { ActionButton } from '../../components/action-button'
import { ButtonLink } from '../../components/button-link'
import { ChartDialog, type Anchor } from '../../components/chart-dialog'
import dialog from '../../components/chart-dialog.module.css'
import { ErrorMessage } from '../../components/feedback'
import { CommitRepositoryLink, RangeRepositoryLink } from '../../components/repository-link'
import { RunSamplesTable, type RunSamples } from '../../components/run-samples-table'
import { plural, shortUuid } from '../../format'
import { commitPath, comparePath, machinePath, regressionPath } from '../../paths'
import { formatMetricValue, type Metric } from '../../schema'
import type { Point } from './points'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema
  metric: Metric
  machine: string
  test: string
  point: Point
  /** The display value of the point's commit. */
  display: string
  /** The point's runs, in the order they were measured, each with its samples, ascending. */
  runs: RunSamples[]
  /** The point before it on its trace, if there is one. */
  previous: Point | null
  sampleAgg: Aggregation
  runAgg: Aggregation
  /** Whether the point's commit is highlighted (GR16). */
  highlighted: boolean
  /** Why no other commit can be highlighted, if as many are as can be. */
  highlightsFull: string | undefined
  /** Highlight the point's commit, or remove its highlight if it is highlighted already. */
  onHighlight(): void
  /** Whether the point's suite, machine and commit are a baseline (GR9). */
  baselined: boolean
  /** Add the point's suite, machine and commit as a baseline, or remove it if it is one already. */
  onBaseline(): void
  /** Where the point is. */
  at: Anchor
  /** The markers of the point's samples (GR10), a press on which does not close the details. */
  companion?: RefObject<Element | null>
  onClose(): void
}

/** Why there is no point before this one to compare it with. */
const FIRST_POINT = 'This is the first point of its trace.'

/**
 * The details of a point clicked on the chart (GR11), in a dialog beside it: its machine, commit,
 * value, its runs with their samples, a comparison with the point before it and the changes since
 * it in the repository, a way to highlight its commit, a way to add it as a baseline, and a way to
 * create a regression from it.
 */
export function PointDetails({
  schema,
  metric,
  machine,
  test,
  point,
  display,
  runs,
  previous,
  sampleAgg,
  runAgg,
  highlighted,
  highlightsFull,
  onHighlight,
  baselined,
  onBaseline,
  at,
  companion,
  onClose,
}: Props) {
  const suite = schema.name

  const side = (commit: string) => ({ suite, machine, commit })
  const compare =
    previous === null
      ? null
      : comparePath(side(previous.commit), side(point.commit), {
          metric: metric.name,
          sampleAgg: linkedAggregation(sampleAgg),
          runAgg: linkedAggregation(runAgg),
        })

  return (
    <ChartDialog
      label={`${test} on ${machine} at ${display}`}
      title={test}
      at={at}
      companion={companion}
      onClose={onClose}
    >
      <dl className={dialog.info}>
        <dt>Machine</dt>
        <dd>
          <Link to={machinePath(suite, machine)}>{machine}</Link>
        </dd>
        <dt>Commit</dt>
        <dd>
          <Link to={commitPath(suite, point.commit)}>{display}</Link>
          <CommitRepositoryLink repository={schema.repository} commit={point.commit} />
        </dd>
        <dt>Value</dt>
        <dd>
          {formatMetricValue(point.value, metric)} ({plural(point.runs, 'run')})
        </dd>
      </dl>
      <div>
        <h3 className={dialog.heading}>Runs</h3>
        <RunSamplesTable label="Runs" suite={suite} metric={metric} runs={runs} />
      </div>
      <div className={dialog.actions}>
        <ButtonLink to={compare} title={compare === null ? FIRST_POINT : undefined}>
          Compare with previous commit
        </ButtonLink>
        <RangeRepositoryLink
          repository={schema.repository}
          action="Diff with previous commit"
          from={previous?.commit ?? null}
          to={point.commit}
          reason={FIRST_POINT}
        />
        {/* Each toggle is the same button either way, so that it keeps the focus (GR11). */}
        <ActionButton reason={highlighted ? undefined : highlightsFull} onClick={onHighlight}>
          {highlighted ? 'Remove the highlight' : 'Highlight this commit'}
        </ActionButton>
        <ActionButton onClick={onBaseline}>
          {baselined ? 'Remove the baseline' : 'Add as baseline'}
        </ActionButton>
        <CreateRegression
          suite={suite}
          machine={machine}
          test={test}
          metric={metric.name}
          commit={point.commit}
        />
      </div>
    </ChartDialog>
  )
}

interface CreateRegressionProps {
  /** The point's suite, machine, test, metric and commit, which the regression is of. */
  suite: string
  machine: string
  test: string
  metric: string
  commit: string
}

/**
 * "Create regression" (GR11): a button opening a form for the regression's title, which creates a
 * regression of the point, and gives way to a link to it. The form cancels as an inline edit does
 * (AR12): with its Cancel button or Escape, giving the focus back to the button.
 */
function CreateRegression({ suite, machine, test, metric, commit }: CreateRegressionProps) {
  const triage = useScopeGate('triage', suite)
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const create = useMutation({
    mutationFn: (titled: string | null) =>
      createRegression(suite, { title: titled, commit, indicators: [{ machine, test, metric }] }),
    onSuccess: async (created) => {
      await regressionCreated(queryClient, suite, created)
      // So that the chart marks it at once (GR15).
      void refetchMarkedRegressions(queryClient, suite)
    },
  })

  // Once the form is cancelled, the button opening it, shown again, takes the focus back.
  const cancelled = useRef(false)
  const opener = (button: HTMLButtonElement | null) => {
    if (button === null || !cancelled.current) return
    cancelled.current = false
    button.focus()
  }
  // Nothing in the form can be used while the regression is created, Escape included (AR12).
  const cancel = () => {
    if (create.isPending) return
    cancelled.current = true
    setOpen(false)
    setTitle('')
    create.reset()
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    // An empty title is none at all: the API refuses empty strings.
    if (!triage.disabled && !create.isPending) create.mutate(title.trim() || null)
  }

  if (create.data !== undefined) {
    const { uuid, title: created } = create.data
    return (
      <span role="status">
        Regression created:{' '}
        <Link ref={focusOnMount} to={regressionPath(suite, uuid)}>
          {created ?? shortUuid(uuid)}
        </Link>
      </span>
    )
  }
  if (!open) {
    return (
      <ActionButton ref={opener} reason={triage.title} onClick={() => setOpen(true)}>
        Create regression
      </ActionButton>
    )
  }
  return (
    <form
      className={styles.detailsCreate}
      aria-label="Create regression"
      onSubmit={submit}
      onKeyDown={(event) => {
        // An Escape ending an input method's composition belongs to it.
        if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
        // It cancels the form rather than close the details.
        event.stopPropagation()
        cancel()
      }}
    >
      <div className={styles.detailsFields}>
        <label className={styles.detailsField}>
          Title
          <input
            type="text"
            value={title}
            maxLength={TEXT_LENGTH}
            placeholder="Untitled"
            readOnly={create.isPending}
            onChange={(event) => setTitle(event.target.value)}
            autoFocus
          />
        </label>
        <ActionButton type="submit" reason={triage.title} busy={create.isPending}>
          {create.isPending ? 'Creating...' : 'Create'}
        </ActionButton>
        <ActionButton busy={create.isPending} onClick={cancel}>
          Cancel
        </ActionButton>
      </div>
      {create.isError && <ErrorMessage error={create.error} />}
    </form>
  )
}

/** Focus the link to the regression created, for the dialog to keep the focus the form had. */
const focusOnMount = (link: HTMLAnchorElement | null) => link?.focus()
