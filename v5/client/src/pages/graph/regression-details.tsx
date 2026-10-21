import { Link } from 'react-router'
import clsx from 'clsx'
import type { MarkedRegression } from '../../api/regressions'
import type { SuiteSchema } from '../../api/suites'
import { BugLink } from '../../components/bug-link'
import { ChartDialog, type Anchor } from '../../components/chart-dialog'
import dialog from '../../components/chart-dialog.module.css'
import { StateBadge } from '../../components/regression-state'
import { formatTimestamp, regressionTitle, shortUuid } from '../../format'
import { commitPath, regressionPath } from '../../paths'
import styles from './graph.module.css'

interface Props {
  schema: SuiteSchema
  regression: MarkedRegression
  /** The selected tests it affects, in order. */
  tests: string[]
  /** The display value of the regression's commit. */
  display: string
  /** Where the regression's marker is. */
  at: Anchor
  onClose(): void
}

/**
 * The details of a regression whose marker was clicked on the chart (GR15), in a dialog beside it:
 * its UUID, linking to its page as the regressions tables' do, its state, commit, bug and creation
 * time, and the selected tests it affects.
 */
export function RegressionDetails({ schema, regression, tests, display, at, onClose }: Props) {
  const suite = schema.name
  const { uuid, state, commit, bug, created_at } = regression
  const title = regressionTitle(regression)
  return (
    <ChartDialog label={`Regression: ${title}`} title={title} at={at} onClose={onClose}>
      <dl className={dialog.info}>
        <dt>Regression</dt>
        <dd>
          <Link to={regressionPath(suite, uuid)} title={uuid} className={styles.uuid}>
            {shortUuid(uuid)}
          </Link>
        </dd>
        <dt>State</dt>
        <dd>
          <StateBadge state={state} />
        </dd>
        <dt>Commit</dt>
        <dd>
          <Link to={commitPath(suite, commit)}>{display}</Link>
        </dd>
        <dt>Bug</dt>
        <dd>
          <BugLink bug={bug} />
        </dd>
        <dt>Created</dt>
        <dd>{formatTimestamp(created_at)}</dd>
      </dl>
      <div>
        <h3 className={dialog.heading}>Selected tests affected</h3>
        <ul className={clsx(dialog.list, styles.detailsTests)} aria-label="Selected tests affected">
          {tests.map((test) => (
            <li key={test}>{test}</li>
          ))}
        </ul>
      </div>
    </ChartDialog>
  )
}
