/**
 * A side of the Profiles page (PF2): its suite, machine, commit, run and test, as the URL names
 * them, checked against what the API holds, and the profile it shows.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { profileQuery } from '../../api/profiles'
import { commitRunsQuery, runProfilesQuery } from '../../api/runs'
import type { SuiteSchema } from '../../api/suites'
import { compareStrings } from '../../format'
import type { Machines } from '../../components/machine-suggestions'
import { runsListFailed, useSuiteAndMachine } from '../../components/side-selection'
import {
  CLEARED_WITH,
  sideChanges,
  sideSettings,
  type Settings,
  type SideId,
  type SideSettings,
} from './settings'
import { runChoice, sideStatus, testChoice, type Carry, type SideStatus } from './selection'

type Run = Schemas['Run']

export interface ProfileSide {
  id: SideId
  settings: SideSettings
  /** The side's suite, once the suites are known to hold it. */
  schema: SuiteSchema | undefined
  machines: Machines
  /** The runs of the machine at the commit that have profiles, in the order they were measured. */
  runs: UseQueryResult<Run[]>
  /** Whether the runs could not be listed, and that is to be said. */
  runsFailed: boolean
  /** The run selected, once the runs are listed and hold it. */
  run: Run | undefined
  /** The profiles of the run the URL names, by test: the side's once `run` is known. */
  profiles: UseQueryResult<Schemas['RunProfile'][]>
  /** The tests the side's run has a profile of, by name, once `run` is known. */
  tests: string[] | undefined
  /** The metadata of the profile of the test in the run, once the test is known. */
  metadata: UseQueryResult<Schemas['ProfileMetadata']>
  status: SideStatus
  /**
   * What the side showed when the user's picks began changing its profile, until it shows one: the
   * test and function the new profile's are carried over from (PF2, PF4).
   */
  carry: Carry | null
  pickSuite(suite: string): void
  pickMachine(machine: string | null): void
  pickCommit(commit: string | null): void
  pickRun(run: string): void
  pickTest(test: string | null): void
}

/**
 * The side `id`, with the settings `all` gives it: the page's, which `update` changes. `suites`
 * lists the suites of the instance.
 *
 * Every request is sent with the URL's values as they are, without waiting for them to be checked
 * (PF8), but what depends on the run is only used once the runs are listed and hold it: the run is
 * the side's machine's at its commit, which the commit picker offers, at a suite that exists.
 */
export function useProfileSide(
  id: SideId,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<SuiteSchema[]>,
): ProfileSide {
  const settings = sideSettings(all, id)
  const { suite, machine, commit, run, test } = settings
  const otherTest = sideSettings(all, id === 'a' ? 'b' : 'a').test
  const [carry, setCarry] = useState<Carry | null>(null)

  // What the page drops, as unusable (AR2 "State").
  const drop = useCallback(
    (changes: Partial<SideSettings>) => update(sideChanges(id, changes)),
    [id, update],
  )
  const { schema, machines } = useSuiteAndMachine({
    suite,
    machine,
    suites,
    onUnusableSuite: () => drop({ suite: '', ...CLEARED_WITH.suite }),
    onUnusableMachine: () => drop({ machine: '', ...CLEARED_WITH.machine }),
  })

  const runs = useQuery({
    ...commitRunsQuery(suite, machine, commit, { has_profiles: true }),
    enabled: suite !== '' && machine !== '' && commit !== '',
  })
  // A list that failed to load again is still shown. One that failed for a machine that may not
  // exist is not reported, unless that cannot be checked, the suites having failed too.
  const runsFailed =
    runs.data === undefined &&
    runs.isError &&
    (runsListFailed(runs, machines, machine) || suites.isError)
  const selected = runs.data?.find((entry) => entry.uuid === run)
  const profiles = useQuery({
    ...runProfilesQuery(suite, run),
    enabled: suite !== '' && run !== '',
  })
  const profileOf = useMemo(
    () => profiles.data && new Map(profiles.data.map((profile) => [profile.test, profile.uuid])),
    [profiles.data],
  )
  const uuid = profileOf?.get(test)
  const metadata = useQuery({ ...profileQuery(suite, uuid ?? ''), enabled: uuid !== undefined })
  // The tests the side's run has a profile of, once the run is known to be the side's.
  const tested = selected ? profileOf : undefined
  const tests = useMemo(
    () => (selected && profileOf ? [...profileOf.keys()].sort(compareStrings) : undefined),
    [selected, profileOf],
  )

  // What the side names without what it depends on is dropped, as clearing that does (PF9).
  useEffect(() => {
    if (suite === '') drop(CLEARED_WITH.suite)
    else if (machine === '') drop(CLEARED_WITH.machine)
    else if (commit === '') drop(CLEARED_WITH.commit)
    else if (test === '') drop(CLEARED_WITH.test)
  }, [suite, machine, commit, test, drop])

  // The latest run is selected in place of none, or of one that is not listed (PF2, PF9), and the
  // side has no test without a run.
  const runPick = runs.data && runChoice(runs.data, run)
  useEffect(() => {
    if (runPick === '') drop(CLEARED_WITH.commit)
    else if (runPick !== undefined && runPick !== run) drop({ run: runPick })
  }, [runPick, run, drop])

  // The test is checked against the run's profiles once the run is known to be the side's: kept,
  // carried over from the other side, or dropped (PF2, PF9).
  const testPick = tested && testChoice(tested, test, otherTest, carry !== null)
  useEffect(() => {
    if (testPick !== undefined && testPick !== test) drop({ test: testPick, function: '' })
  }, [testPick, test, drop])

  const status = sideStatus({ test, run, runPick, runsFailed, profiles, testPick, uuid, metadata })

  // The carry is used up once the side's new profile is resolved, or it is left without one.
  if (carry !== null && (status.kind === 'shown' || runPick === '' || testPick === '')) {
    setCarry(null)
  }

  // A pick that changes the side's profile carries over what the side showed, and the function
  // goes from the URL with the test it belonged to.
  const change = (changes: Partial<SideSettings>) => {
    setCarry(carry ?? { test, function: settings.function })
    update(sideChanges(id, { ...changes, function: '' }))
  }
  // A pick that clears what the side showed carries nothing over.
  const clear = (changes: Partial<SideSettings>) => {
    setCarry(null)
    update(sideChanges(id, changes))
  }

  return {
    id,
    settings,
    schema,
    machines,
    runs,
    runsFailed,
    run: selected,
    profiles,
    tests,
    metadata,
    status,
    carry,
    pickSuite: (name) => clear({ suite: name, ...CLEARED_WITH.suite }),
    pickMachine: (name) =>
      // Another machine keeps the commit if it has profiles at it, as the commit picker checks.
      name === null
        ? clear({ machine: '', ...CLEARED_WITH.machine })
        : change({ machine: name, run: '' }),
    pickCommit: (value) =>
      value === null
        ? clear({ commit: '', ...CLEARED_WITH.commit })
        : change({ commit: value, run: '' }),
    pickRun: (uuid) => change({ run: uuid }),
    pickTest: (name) =>
      name === null ? clear({ test: '', ...CLEARED_WITH.test }) : change({ test: name }),
  }
}
