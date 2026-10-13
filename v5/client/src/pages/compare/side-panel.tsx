import { useMemo, type ReactNode } from 'react'
import { AGGREGATION_OPTIONS, type Aggregation } from '../../aggregation'
import type { SuiteSchema } from '../../api/suites'
import { Combobox } from '../../components/combobox'
import { CommitPicker } from '../../components/commit-picker'
import { ControlsPanel } from '../../components/controls-panel'
import { ErrorMessage, Loading } from '../../components/feedback'
import { SelectAllBox, SelectBox } from '../../components/select-box'
import { Select } from '../../components/select'
import { NO_SUGGESTIONS } from '../../components/suggestions'
import { UuidLink } from '../../components/uuid-link'
import { formatTimestamp, uuidPrefix } from '../../format'
import { runPath } from '../../paths'
import type { Side } from './use-side'
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
 * the runs of the machine at the commit, every one selected to begin with, and how they are
 * combined.
 */
export function SidePanel({ side, title, suites, action }: Props) {
  const { settings, schema, machines, selected, update: onChange } = side
  const { suite, machine, commit } = settings
  const filters = useMemo(() => ({ machine }), [machine])
  const letter = side.id.toUpperCase()

  const commitPlaceholder = machine === '' ? 'Select a machine first' : 'Select a commit'
  return (
    <ControlsPanel>
      <section className={styles.side} aria-label={title}>
        <div className={styles.sideHeader}>
          <h2 className={styles.sideTitle}>{title}</h2>
          {action}
        </div>
        <Select
          label={`Suite ${letter}`}
          options={suites.map(({ name }) => ({ value: name, label: name }))}
          value={schema?.name ?? null}
          placeholder="-- Select suite --"
          onChange={(name) => onChange({ suite: name, machine: '', commit: '', runs: [] })}
        />
        <Combobox
          label={`Machine ${letter}`}
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
            label={`Commit ${letter}`}
            value={null}
            onChange={noop}
            suggestions={NO_SUGGESTIONS}
            placeholder={commitPlaceholder}
            isDisabled
          />
        ) : (
          <CommitPicker
            label={`Commit ${letter}`}
            schema={schema}
            filters={filters}
            value={commit === '' ? null : commit}
            onChange={(value) => onChange({ commit: value ?? '', runs: [] })}
            placeholder={commitPlaceholder}
            isDisabled={machine === ''}
          />
        )}
        <RunList side={side} />
        <Select<Aggregation>
          label={`Run aggregation ${letter}`}
          options={AGGREGATION_OPTIONS}
          value={settings.runAgg}
          onChange={(value) => onChange({ runAgg: value })}
          isDisabled={selected === undefined || selected.size <= 1}
        />
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

/** The runs of the side's machine at its commit, each selected with its checkbox (CP1). */
function RunList({ side }: { side: Side }) {
  const { settings, runs, selection, machines } = side
  const letter = side.id.toUpperCase()
  if (settings.commit === '') return <p className={styles.note}>Select a commit first.</p>
  // A machine that does not exist has no runs to list: it is about to be dropped.
  const machineKnown = machines.machines.data?.includes(settings.machine) ?? false
  if (runs.isError && (machineKnown || machines.machines.isError)) {
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
        <SelectAllBox rows={selection} shown={uuids} label={`Select all runs of side ${letter}`} />
        Runs
      </legend>
      {runs.data.map((run) => (
        <div key={run.uuid} className={styles.run}>
          <SelectBox
            rows={selection}
            rowKey={run.uuid}
            label={`Run ${uuidPrefix(run.uuid)} of side ${letter}`}
          />
          {formatTimestamp(run.submitted_at)}{' '}
          <UuidLink uuid={run.uuid} to={runPath(settings.suite, run.uuid)} />
        </div>
      ))}
    </fieldset>
  )
}
