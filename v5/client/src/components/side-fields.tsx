/**
 * A side of a suite-agnostic comparison page (CP1, PF2): the box holding its controls, and the first
 * of them, its suite, machine and commit.
 */

import { useMemo, type ReactNode } from 'react'
import type { CommitFilters } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { Combobox } from './combobox'
import { CommitPicker } from './commit-picker'
import { ControlsPanel } from './controls-panel'
import { ErrorMessage } from './feedback'
import type { Machines } from './machine-suggestions'
import { Select } from './select'
import { machineFailuresReportable } from './side-selection'
import { NO_SUGGESTIONS } from './suggestions'
import styles from './side-fields.module.css'

function noop() {}

const NO_FILTERS: Omit<CommitFilters, 'machine'> = {}

interface Props {
  suites: SuiteSchema[]
  /** The side's suite, once known to exist (see `useSuiteAndMachine`). */
  schema: SuiteSchema | undefined
  /** The suite's machines (see `useSuiteAndMachine`). */
  machines: Machines
  /** The side's machine, or `''` for none. */
  machine: string
  /** The side's commit, or `''` for none. */
  commit: string
  /**
   * Extra filters on the machine's commits that the commit picker offers. Pass the same object for
   * as long as the filters stay the same.
   */
  commitFilters?: Omit<CommitFilters, 'machine'>
  /** What the commit picker says when the machine has no commit to offer (see `Combobox`). */
  noCommitsMessage?: string
  /** What goes beside the commit picker's label, such as a link to the commit (see `Combobox`). */
  commitAside?: ReactNode
  /** A suite was picked. */
  onSuite(suite: string): void
  /**
   * Called with the machine picked, or with null when the machine is cleared. The commit picker
   * then decides whether to keep the commit: it keeps it only if the new machine has it (AR15).
   */
  onMachine(machine: string | null): void
  /** Called with the commit picked, or with null when it is cleared (see `CommitPicker`). */
  onCommit(commit: string | null): void
}

/**
 * A side's suite dropdown, machine combobox and commit picker. Each one stays disabled, and says
 * why, until the control it depends on has a value. Below the machine combobox, says if the suite's
 * machines could not be listed.
 */
export function SideFields({
  suites,
  schema,
  machines,
  machine,
  commit,
  commitFilters = NO_FILTERS,
  noCommitsMessage,
  commitAside,
  onSuite,
  onMachine,
  onCommit,
}: Props) {
  const filters = useMemo(() => ({ ...commitFilters, machine }), [commitFilters, machine])
  return (
    <>
      <Select
        label="Suite"
        options={suites.map(({ name }) => ({ value: name, label: name }))}
        value={schema?.name ?? null}
        placeholder="-- Select suite --"
        onChange={onSuite}
      />
      <Combobox
        label="Machine"
        value={machine === '' ? null : { key: machine, text: machine }}
        onChange={(picked) => onMachine(picked?.key ?? null)}
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
      {/* The machines are only fetched once the suite is known to exist. */}
      {schema !== undefined && <MachinesError suite={schema.name} machines={machines} />}
      {/* Without a machine, a commit picker would look its commit up among no machine's. */}
      {schema === undefined || machine === '' ? (
        <Combobox
          label="Commit"
          value={null}
          onChange={noop}
          suggestions={NO_SUGGESTIONS}
          placeholder={machine === '' ? 'Select a machine first' : 'Select a commit'}
          isDisabled
        />
      ) : (
        <CommitPicker
          label="Commit"
          schema={schema}
          filters={filters}
          value={commit === '' ? null : commit}
          onChange={onCommit}
          placeholder="Select a commit"
          emptyMessage={noCommitsMessage}
          labelAside={commitAside}
          reportsLookupFailure={machineFailuresReportable(machines, machine)}
        />
      )}
    </>
  )
}

interface SideControlsProps {
  /** The side's heading, which also names its controls for assistive technology. */
  title: string
  /** What the heading offers to do with the side, if anything, beside it. */
  action?: ReactNode
  /** The side's controls, `SideFields` first. */
  children: ReactNode
}

/**
 * The box holding a side's controls, under its heading. They take the side's width, whatever they
 * hold, so that a long machine name has room, and nothing moves as they change.
 */
export function SideControls({ title, action, children }: SideControlsProps) {
  return (
    <ControlsPanel>
      <section className={styles.side} aria-label={title}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          {action}
        </div>
        {children}
      </section>
    </ControlsPanel>
  )
}

/** Says that the machines of `suite` could not be listed, with a way to try again, if so. */
function MachinesError({ suite, machines }: { suite: string; machines: Machines }) {
  if (!machines.machines.isError) return null
  return (
    <ErrorMessage
      context={`The machines of ${suite} could not be listed`}
      error={machines.machines.error}
      onRetry={() => void machines.machines.refetch()}
    />
  )
}
