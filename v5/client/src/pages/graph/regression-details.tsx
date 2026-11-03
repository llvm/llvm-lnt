import { Link } from 'react-router'
import clsx from 'clsx'
import type { MarkedRegression } from '../../api/regressions'
import { refOf, type Suite } from '../../api/suites'
import { ChartDialog, type Anchor } from '../../components/chart-dialog'
import dialog from '../../components/chart-dialog.module.css'
import { ListedCommitLink } from '../../components/commit-link'
import { LinkableText } from '../../components/linkable-text'
import { StateBadge } from '../../components/regression-state'
import { formatTimestamp, MISSING, regressionTitle, shortUuid } from '../../format'
import { regressionPath } from '../../paths'
import type { Commit } from '../../schema'
import styles from './graph.module.css'

interface Props {
  schema: Suite
  regression: MarkedRegression
  /** The selected tests it affects, in order. */
  tests: string[]
  /** The regression's commit, from the x-axis, where its marker is (GR3). */
  commit: Commit
  /** Where the regression's marker is. */
  at: Anchor
  onClose(): void
}

/**
 * The details of a regression whose marker was clicked on the chart (GR15), in a dialog beside it:
 * its UUID, linking to its page as the regressions tables' do, its state, commit, bug and creation
 * time, and the selected tests it affects.
 */
export function RegressionDetails({ schema, regression, commit, tests, at, onClose }: Props) {
  const suite = refOf(schema)
  const { uuid, state, bug, created_at } = regression
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
          <ListedCommitLink schema={schema} value={commit.value} commit={commit} />
        </dd>
        <dt>Bug</dt>
        <dd>{bug === null ? MISSING : <LinkableText text={bug} />}</dd>
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
