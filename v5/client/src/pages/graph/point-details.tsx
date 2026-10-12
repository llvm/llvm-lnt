import { useEffect, useRef } from 'react'
import { Link } from 'react-router'
import type { Aggregation } from '../../aggregation'
import type { TraceState } from '../../api/series'
import type { SuiteSchema } from '../../api/suites'
import { ButtonLink } from '../../components/button-link'
import { formatTimestamp, plural, shortUuid } from '../../format'
import { commitPath, comparePath, machinePath, runPath } from '../../paths'
import { formatMetricValue, type Metric } from '../../schema'
import type { Point, RunValue } from './points'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema
  metric: Metric
  machine: string
  test: string
  point: Point
  /** The display value of the point's commit. */
  display: string
  /** The point's runs, each with its value, in the order they were submitted. */
  runs: RunValue[]
  /** The point before it on its trace, if there is one. */
  previous: Point | null
  /** How far the trace's data is loaded. */
  state: TraceState
  sampleAgg: Aggregation
  runAgg: Aggregation
  /** Where the point is, in pixels in the chart's container, and on which side of it to open. */
  at: { x: number; y: number; side: 'left' | 'right' }
  /** Close the details: by the keyboard or their button (`returnFocus`), or by a press outside. */
  onClose(returnFocus?: boolean): void
}

/**
 * The details of a point clicked on the chart (GR11), in a dialog beside it, which takes the focus
 * and stays open as the pointer moves, until Escape, its close button, or a press outside it.
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
  state,
  sampleAgg,
  runAgg,
  at,
  onClose,
}: Props) {
  const suite = schema.name
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => root.current?.focus(), [])
  useEffect(() => {
    // A press on another point closes this one before the click opens that one's.
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  // A side's aggregation in the comparison's URL, unless it is Compare's default.
  const unlessDefault = (how: Aggregation) => (how === 'median' ? undefined : how)
  const side = (commit: string) => ({ suite, machine, commit, runAgg: unlessDefault(runAgg) })
  let compare: string | null = null
  let why: string | undefined
  if (state === 'loading') why = "The test's data is still loading."
  else if (state === 'failed') why = "The test's data could not all be loaded."
  else if (previous === null) why = 'This is the first point of its trace.'
  else {
    compare = comparePath(
      side(previous.commit),
      side(point.commit),
      metric.name,
      unlessDefault(sampleAgg),
    )
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={`${test} on ${machine} at ${display}`}
      tabIndex={-1}
      className={styles.details}
      style={{
        left: at.x,
        top: at.y,
        transform: `translate(${at.side === 'right' ? '12px' : 'calc(-100% - 12px)'}, -50%)`,
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose(true)
      }}
    >
      <div className={styles.detailsHeader}>
        <strong className={styles.detailsTest}>{test}</strong>
        <button
          type="button"
          className={styles.remove}
          aria-label="Close"
          onClick={() => onClose(true)}
        >
          ×
        </button>
      </div>
      <dl className={styles.detailsInfo}>
        <dt>Machine</dt>
        <dd>
          <Link to={machinePath(suite, machine)}>{machine}</Link>
        </dd>
        <dt>Commit</dt>
        <dd>
          <Link to={commitPath(suite, point.commit)}>{display}</Link>
        </dd>
        <dt>Value</dt>
        <dd>
          {formatMetricValue(point.value, metric)} ({plural(point.runs, 'run')})
        </dd>
      </dl>
      <ul className={styles.detailsRuns} aria-label="Runs">
        {runs.map((run) => (
          <li key={run.run}>
            {formatTimestamp(run.submitted)}{' '}
            <Link to={runPath(suite, run.run)} className={styles.mono}>
              {shortUuid(run.run)}
            </Link>{' '}
            {formatMetricValue(run.value, metric)}
          </li>
        ))}
      </ul>
      <ButtonLink to={compare} title={why}>
        Compare with previous
      </ButtonLink>
    </div>
  )
}
