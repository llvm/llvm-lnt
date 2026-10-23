import { useMemo } from 'react'
import type { SuiteSchema } from '../../api/suites'
import { Combobox } from '../../components/combobox'
import { ErrorMessage } from '../../components/feedback'
import { Select } from '../../components/select'
import { SideControls, SideFields } from '../../components/side-fields'
import { useLocalSuggestions } from '../../components/suggestions'
import { UuidLink } from '../../components/uuid-link'
import { formatTimestamp, uuidPrefix } from '../../format'
import { runPath } from '../../paths'
import { defaultFromA } from './defaults'
import type { ProfileSide } from './use-side'
import styles from './profiles.module.css'

/** The commits a side's commit picker offers: those at which the machine has profiles (PF2). */
const HAS_PROFILES = { has_profiles: true } as const

interface Props {
  side: ProfileSide
  /** The side's heading: "Side A" or "Side B". */
  title: string
  suites: SuiteSchema[]
}

/**
 * A side's controls (PF2): its suite, machine, commit, run and test. Each choice clears the
 * controls that depend on it.
 */
export function SidePanel({ side, title, suites }: Props) {
  const { settings, schema, machines } = side
  return (
    <SideControls title={title}>
      <SideFields
        suites={suites}
        schema={schema}
        machines={machines}
        machine={settings.machine}
        commit={settings.commit}
        commitFilters={HAS_PROFILES}
        noCommitsMessage="No profiles on this machine"
        onSuite={side.pickSuite}
        onMachine={side.pickMachine}
        onCommit={side.pickCommit}
      />
      <RunField side={side} />
      <TestField side={side} />
    </SideControls>
  )
}

/**
 * The runs with profiles of the side's machine at its commit, in the order they were measured.
 * Beside them, a link goes to the selected run's Run Detail page (PF2).
 */
function RunField({ side }: { side: ProfileSide }) {
  const { settings, runs, run } = side
  const options = useMemo(
    () =>
      (runs.data ?? []).map((entry) => ({
        value: entry.uuid,
        label: `${formatTimestamp(entry.measured_at)} ${uuidPrefix(entry.uuid)}`,
      })),
    [runs.data],
  )
  let placeholder = 'Select a run'
  if (settings.commit === '') placeholder = 'Select a commit first'
  else if (runs.data === undefined && !side.runsFailed) placeholder = 'Loading runs...'
  else if (runs.data?.length === 0) placeholder = 'No runs with profiles'
  return (
    <>
      <div className={styles.run}>
        <Select
          label="Run"
          options={options}
          value={run?.uuid ?? null}
          placeholder={placeholder}
          onChange={side.pickRun}
          isDisabled={options.length === 0}
        />
        {run && <UuidLink uuid={run.uuid} to={runPath(settings.suite, run.uuid)} label="Run" />}
      </div>
      {side.runsFailed && (
        <ErrorMessage
          context="The runs could not be listed"
          error={runs.error}
          onRetry={() => void runs.refetch()}
        />
      )}
    </>
  )
}

/**
 * The tests that have a profile in the side's run, sorted by name and filtered locally (PF2). Side
 * B shows its default test, side A's, as inherited, also while it checks it against its run.
 */
function TestField({ side }: { side: ProfileSide }) {
  const { settings, run, profiles, tests } = side
  const suggestions = useLocalSuggestions(
    useMemo(() => tests?.map((test) => ({ key: test, text: test })), [tests]),
    null,
  )
  // Only once the run is known to be the side's: the URL's run may belong to another machine, or
  // not exist.
  const failed = run !== undefined && tests === undefined && profiles.isError

  let placeholder = 'Select a test'
  if (run === undefined) placeholder = 'Select a run first'
  else if (tests === undefined && !failed) placeholder = 'Loading tests...'
  return (
    <>
      <Combobox
        label="Test"
        value={settings.test === '' ? null : { key: settings.test, text: settings.test }}
        onChange={(picked) => side.pickTest(picked?.key ?? null)}
        suggestions={suggestions}
        placeholder={placeholder}
        inherited={side.usesDefaultTest ? defaultFromA(side.test) : undefined}
        isDisabled={tests === undefined}
        // A run can have a profile of each of thousands of tests (AR9).
        virtualized
      />
      {failed && (
        <ErrorMessage
          context="The run's profiles could not be listed"
          error={profiles.error}
          onRetry={() => void profiles.refetch()}
        />
      )}
    </>
  )
}
