/**
 * The controls a side of a suite-agnostic comparison page starts with: its suite, machine and
 * commit (CP1, PF2).
 */

import { useMemo } from 'react'
import type { CommitFilters } from '../api/commits'
import type { SuiteSchema } from '../api/suites'
import { Combobox } from './combobox'
import { CommitPicker } from './commit-picker'
import { ErrorMessage } from './feedback'
import type { Machines } from './machine-suggestions'
import { Select } from './select'
import { machineFailuresReportable } from './side-selection'
import { NO_SUGGESTIONS } from './suggestions'

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
   * Which of the machine's commits the commit picker offers, if not all of them. Pass the same
   * object while they are alike.
   */
  commitFilters?: Omit<CommitFilters, 'machine'>
  /** A suite was picked. */
  onSuite(suite: string): void
  /**
   * A machine was picked, or the machine was cleared (null). What a pick keeps of the commit is
   * left to the commit picker, which checks that the new machine has it (AR15).
   */
  onMachine(machine: string | null): void
  /** A commit was picked, or the commit was cleared (null), as `CommitPicker` reports them. */
  onCommit(commit: string | null): void
}

/**
 * A side's suite dropdown, machine combobox and commit picker, each disabled until what it depends
 * on is selected, saying so.
 */
export function SideFields({
  suites,
  schema,
  machines,
  machine,
  commit,
  commitFilters = NO_FILTERS,
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
          reportsLookupFailure={machineFailuresReportable(machines, machine)}
        />
      )}
    </>
  )
}

/** That the machines of `suite` could not be listed, if they could not, with a way to try again. */
export function MachinesError({ suite, machines }: { suite: string; machines: Machines }) {
  if (!machines.machines.isError) return null
  return (
    <ErrorMessage
      context={`The machines of ${suite} could not be listed`}
      error={machines.machines.error}
      onRetry={() => void machines.machines.refetch()}
    />
  )
}
