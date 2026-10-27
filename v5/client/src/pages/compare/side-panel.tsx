import type { ReactNode } from 'react'
import type { SuiteSchema } from '../../api/suites'
import { ErrorMessage, Loading } from '../../components/feedback'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import { SideControls, SideFields } from '../../components/side-fields'
import { runsListFailed } from '../../components/side-selection'
import { UuidLink } from '../../components/uuid-link'
import { formatTimestamp, uuidPrefix } from '../../format'
import { runPath } from '../../paths'
import { SideCommitLink } from './repository-links'
import { CLEARED_WITH } from './settings'
import type { Side } from './use-side'
import styles from './compare.module.css'

interface Props {
  side: Side
  /** The side's heading: "Side A (Baseline)" or "Side B (New)". */
  title: string
  suites: SuiteSchema[]
  /** What the heading offers to do with the side, if anything, such as pinning it (CP8). */
  action?: ReactNode
}

/**
 * A side's controls (CP1): its suite, machine and commit, each choice clearing what depends on it,
 * with a link to the commit in its repository, and the runs of the machine at the commit, every one
 * selected to begin with.
 */
export function SidePanel({ side, title, suites, action }: Props) {
  const { settings, schema, machines, update: onChange } = side
  const { machine, commit } = settings

  return (
    <SideControls title={title} action={action}>
      <SideFields
        suites={suites}
        schema={schema}
        machines={machines}
        machine={machine}
        commit={commit}
        commitAside={<SideCommitLink side={side} />}
        onSuite={(name) => onChange({ suite: name, ...CLEARED_WITH.suite })}
        onMachine={(picked) =>
          // Another machine keeps the commit if it has runs at it, as the commit picker checks.
          onChange(
            picked === null
              ? { machine: '', ...CLEARED_WITH.machine }
              : { machine: picked, runs: [] },
          )
        }
        onCommit={(value) => onChange({ commit: value ?? '', ...CLEARED_WITH.commit })}
      />
      <RunList side={side} />
    </SideControls>
  )
}

/**
 * The runs of the side's machine at its commit, in a box of their own that scrolls once they are
 * many, each selected with its checkbox, a range of them with Shift, or all at once from the header
 * (CP1).
 */
function RunList({ side }: { side: Side }) {
  const { settings, runs, selection } = side
  if (!side.named) return <p className={styles.note}>Select a commit first.</p>
  if (runsListFailed(runs, side.machines, settings.machine)) {
    return (
      <ErrorMessage
        context="The runs could not be listed"
        error={runs.error}
        onRetry={() => void runs.refetch()}
      />
    )
  }
  if (runs.data === undefined) return <Loading label="Loading runs..." />
  if (runs.data.length === 0) return <p className={styles.note}>No runs.</p>
  const uuids = runs.data.map((run) => run.uuid)
  return (
    <fieldset className={styles.runs}>
      <legend className={styles.runsLegend}>
        <SelectAllBox rows={selection} shown={uuids} label="Select all runs" />
        Runs
      </legend>
      <div className={styles.runList}>
        {runs.data.map((run) => (
          <div key={run.uuid} className={styles.run}>
            <SelectBox rows={selection} rowKey={run.uuid} label={`Run ${uuidPrefix(run.uuid)}`} />
            <span className={styles.runTime}>{formatTimestamp(run.measured_at)}</span>
            <UuidLink
              uuid={run.uuid}
              to={runPath(settings.suite, run.uuid)}
              label="UUID"
              className={styles.runUuid}
            />
          </div>
        ))}
      </div>
    </fieldset>
  )
}
