import { useMemo, type ReactNode } from 'react'
import type { SuiteSchema } from '../../api/suites'
import { Combobox } from '../../components/combobox'
import { CommitPicker } from '../../components/commit-picker'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { SelectBox } from '../../components/select-box'
import { Select } from '../../components/select'
import { NO_SUGGESTIONS } from '../../components/suggestions'
import { UuidLink } from '../../components/uuid-link'
import { formatTimestamp, uuidPrefix } from '../../format'
import { runPath } from '../../paths'
import { runsListFailed, type Side } from './use-side'
import styles from './compare.module.css'

function noop() {}

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
 * and the runs of the machine at the commit, every one selected to begin with.
 */
export function SidePanel({ side, title, suites, action }: Props) {
  const { settings, schema, machines, update: onChange } = side
  const { suite, machine, commit } = settings
  const filters = useMemo(() => ({ machine }), [machine])

  const commitPlaceholder = machine === '' ? 'Select a machine first' : 'Select a commit'
  return (
    <ControlsPanel>
      <section className={styles.side} aria-label={title}>
        <div className={styles.sideHeader}>
          <h2 className={styles.sideTitle}>{title}</h2>
          {action}
        </div>
        <Select
          label="Suite"
          options={suites.map(({ name }) => ({ value: name, label: name }))}
          value={schema?.name ?? null}
          placeholder="-- Select suite --"
          onChange={(name) => onChange({ suite: name, machine: '', commit: '', runs: [] })}
        />
        <Combobox
          label="Machine"
          value={machine === '' ? null : { key: machine, text: machine }}
          onChange={(picked) =>
            // Another machine keeps the commit if it has runs at it, as the commit picker checks.
            onChange(
              picked === null
                ? { machine: '', commit: '', runs: [] }
                : { machine: picked.key, runs: [] },
            )
          }
          suggestions={machines.suggestions}
          placeholder={
            schema === undefined
              ? 'Select a suite first'
              : machines.machines.isPending
                ? 'Loading machines...'
                : 'Select a machine'
          }
          isDisabled={schema === undefined}
        />
        {schema === undefined ? (
          <Combobox
            label="Commit"
            value={null}
            onChange={noop}
            suggestions={NO_SUGGESTIONS}
            placeholder={commitPlaceholder}
            isDisabled
          />
        ) : (
          <CommitPicker
            label="Commit"
            schema={schema}
            filters={filters}
            value={commit === '' ? null : commit}
            onChange={(value) => onChange({ commit: value ?? '', runs: [] })}
            placeholder={commitPlaceholder}
            isDisabled={machine === ''}
          />
        )}
        <RunList side={side} />
      </section>
      {machines.machines.isError && (
        <ErrorMessage
          context={`The machines of ${suite} could not be listed`}
          error={machines.machines.error}
          onRetry={() => void machines.machines.refetch()}
        />
      )}
    </ControlsPanel>
  )
}

/**
 * The runs of the side's machine at its commit, in a box of their own that scrolls once they are
 * many, each selected with its checkbox, or a range of them with Shift (CP1).
 */
function RunList({ side }: { side: Side }) {
  const { settings, runs, selection } = side
  if (settings.commit === '') return <p className={styles.note}>Select a commit first.</p>
  if (runsListFailed(side)) {
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
  return (
    <fieldset className={styles.runs}>
      <legend className={styles.runsLegend}>Runs</legend>
      <div className={styles.runList}>
        {runs.data.map((run) => (
          <div key={run.uuid} className={styles.run}>
            <SelectBox
              rows={selection}
              rowKey={run.uuid}
              label={`Run ${uuidPrefix(run.uuid)}`}
            />
            <span className={styles.runTime}>{formatTimestamp(run.submitted_at)}</span>
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
