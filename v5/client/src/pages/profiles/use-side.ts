/**
 * A side of the Profiles page (PF2): the suite, machine, commit, run and test that the URL names,
 * checked against what the API holds, and the profile that the side shows. Side B follows side A's
 * test while it has none of its own.
 */

import { useCallback, useEffect, useMemo, type Dispatch } from 'react'
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
import type { HeldFunction } from './functions'
import {
  NO_PICKS,
  runChoice,
  sideStatus,
  type Carry,
  type SidePicks,
  type SidePicksAction,
  type SideStatus,
} from './selection'

type Run = Schemas['Run']

export interface ProfileSide {
  id: SideId
  /** The side's own settings, as the URL holds them. */
  settings: SideSettings
  /**
   * The test the side shows, or is checking against its run: its own, or the one it follows. It is
   * `''` once the side turns out to have none.
   */
  test: string
  /** Whether side B follows side A's test, having a commit but no test of its own. */
  follows: boolean
  /** The side's suite, once the suite list shows that it exists. */
  schema: SuiteSchema | undefined
  machines: Machines
  /** The runs of the machine at the commit that have profiles, in the order they were measured. */
  runs: UseQueryResult<Run[]>
  /** Whether listing the runs failed, and the page should report it. */
  runsFailed: boolean
  /** The selected run, once the runs are listed and include it. */
  run: Run | undefined
  /** The profiles of the run that the URL names, by test. They are the side's once `run` is set. */
  profiles: UseQueryResult<Schemas['RunProfile'][]>
  /** The tests that have a profile in the side's run, sorted by name, once `run` is set. */
  tests: string[] | undefined
  /** The metadata of the profile of the test in the run, once the test is known. */
  metadata: UseQueryResult<Schemas['ProfileMetadata']>
  status: SideStatus
  /** The UUID of the test's profile in the run that the URL names, once the profiles are listed. */
  uuid: string | undefined
  /**
   * What side A showed when the user's picks began changing its profile (see `Carry`). These last
   * three are side A's: side B, which keeps no picks, carries and holds nothing.
   */
  carry: Carry | null
  /**
   * The function side A shows (null for none), once known for the profile shown. It holds it by
   * its name, never as a placeholder for the hottest function (see `ShownFunction`).
   */
  heldFunction: string | null | undefined
  /**
   * Side A's function is now known: hold it, and drop the carry. Only the component that holds
   * the side's picks may call this, while it renders (see `useProfileSide`).
   */
  settleFunction(held: HeldFunction): void
  pickSuite(suite: string): void
  pickMachine(machine: string | null): void
  pickCommit(commit: string | null): void
  pickRun(run: string): void
  pickTest(test: string | null): void
}

/**
 * The side `id`, with the settings `all` gives it: the page's, which `update` changes. `suites`
 * lists the suites of the instance. `picks` holds what side A keeps of the user's picks besides
 * the URL (see `SidePicks`); side B keeps none. This hook and `useFunctions` both change it while
 * rendering. React only allows that for a component's own state, so the component that calls them
 * must hold `picks`.
 *
 * The side sends every request with the URL's values as they are, without first checking them
 * (PF8). It only uses what depends on the run once the run list includes the run. That shows that
 * the run belongs to the side's machine at its commit, which the commit picker offers, in a suite
 * that exists.
 */
export function useProfileSide(
  id: SideId,
  all: Settings,
  update: (changes: Partial<Settings>) => void,
  suites: UseQueryResult<SuiteSchema[]>,
  picks?: [SidePicks, Dispatch<SidePicksAction>],
): ProfileSide {
  const settings = sideSettings(all, id)
  const { suite, machine, commit, run, test: own } = settings
  const [kept, dispatch] = picks ?? [NO_PICKS, undefined]
  const { carry, held } = kept
  // Side B follows side A's test, as A's URL names it, while it has a commit and no test of its
  // own (PF2). It checks that test against its run as it would its own, but never drops it.
  const follows = id === 'b' && own === '' && commit !== ''
  const named = follows ? all.test_a : own

  // What the page drops, as unusable (AR2 "State").
  const drop = useCallback(
    (changes: Partial<SideSettings>) => update(sideChanges(id, changes)),
    [id, update],
  )
  // When a pick clears what the side showed, or the page drops it, the side keeps nothing of it.
  const clear = (changes: Partial<SideSettings>) => {
    dispatch?.({ type: 'clear' })
    drop(changes)
  }
  const { schema, machines } = useSuiteAndMachine({
    suite,
    machine,
    suites,
    onUnusableSuite: () => clear({ suite: '', ...CLEARED_WITH.suite }),
    onUnusableMachine: () => clear({ machine: '', ...CLEARED_WITH.machine }),
  })

  const runs = useQuery({
    ...commitRunsQuery(suite, machine, commit, { has_profiles: true }),
    enabled: suite !== '' && machine !== '' && commit !== '',
  })
  // If a run list loaded once and a refetch fails, the side keeps using it. A failure is not
  // reported while the machine may not exist, unless the page cannot check that because the suites
  // failed too.
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
  const uuid = profileOf?.get(named)
  const metadata = useQuery({ ...profileQuery(suite, uuid ?? ''), enabled: uuid !== undefined })
  // The tests the side's run has a profile of, once the run is known to be the side's.
  const tested = selected ? profileOf : undefined
  const tests = useMemo(
    () => (selected && profileOf ? [...profileOf.keys()].sort(compareStrings) : undefined),
    [selected, profileOf],
  )

  // Select the latest run when there is none, or when the run is not listed (PF2, PF9). With no
  // run to select, the side has no test either.
  const runPick = runs.data && runChoice(runs.data, run)
  useEffect(() => {
    if (runPick === '') drop(CLEARED_WITH.commit)
    else if (runPick !== undefined && runPick !== run) drop({ run: runPick })
  }, [runPick, run, drop])

  // Once the run is known to be the side's, check the test against the run's profiles: keep it, or
  // drop it, which leaves side B following side A's (PF2, PF9). A test that side B follows is never
  // dropped: side B shows none while its run has no profile of it.
  const testPick = tested && (tested.has(named) ? named : '')
  useEffect(() => {
    if (!follows && testPick === '') drop({ test: '' })
  }, [follows, testPick, drop])
  const test = follows && testPick === '' ? '' : named

  // Drop what the side names without the control it depends on, as clearing that does (PF9).
  // Side B's function needs a test, which may be the one it follows.
  useEffect(() => {
    if (suite === '') drop(CLEARED_WITH.suite)
    else if (machine === '') drop(CLEARED_WITH.machine)
    else if (commit === '') drop(CLEARED_WITH.commit)
    else if (test === '') drop(CLEARED_WITH.test)
  }, [suite, machine, commit, test, drop])

  const status = sideStatus({ test, run, runPick, runsFailed, profiles, testPick, uuid, metadata })

  // A side left without a profile keeps nothing of it. A side that shows a profile drops its carry
  // once its function is known (see `useFunctions`).
  if (kept !== NO_PICKS && (runPick === '' || testPick === '')) dispatch?.({ type: 'clear' })

  const heldFunction =
    status.kind === 'shown' && held?.profile === status.uuid ? held.name : undefined
  const settleFunction = useCallback(
    (next: HeldFunction) => dispatch?.({ type: 'settle', held: next }),
    [dispatch],
  )

  // A pick that changes side A's profile carries over what it showed. Until side A knows its
  // function, it carries the URL's function, which the new profile is checked against anyway. The
  // pick also removes the function from the URL, along with the test it belonged to. Side B carries
  // nothing, and keeps its own function in the URL, whatever its test: the new profile is checked
  // against it (PF4, PF9).
  const change = (changes: Partial<SideSettings>) => {
    if (id === 'b') return drop(changes)
    const name = heldFunction !== undefined ? heldFunction : settings.function || null
    dispatch?.({ type: 'change', shown: { test, name } })
    drop({ ...changes, function: '' })
  }

  return {
    id,
    settings,
    test,
    follows,
    schema,
    machines,
    runs,
    runsFailed,
    run: selected,
    profiles,
    tests,
    metadata,
    status,
    uuid,
    carry,
    heldFunction,
    settleFunction,
    pickSuite: (name) => clear({ suite: name, ...CLEARED_WITH.suite }),
    pickMachine: (name) =>
      // The new machine keeps the commit if it has profiles there, which the commit picker checks.
      name === null
        ? clear({ machine: '', ...CLEARED_WITH.machine })
        : change({ machine: name, run: '' }),
    pickCommit: (value) =>
      value === null
        ? clear({ commit: '', ...CLEARED_WITH.commit })
        : change({ commit: value, run: '' }),
    pickRun: (uuid) => change({ run: uuid }),
    pickTest: (name) => {
      if (name !== null) change({ test: name })
      // Side B's own function does not depend on its test (PF4).
      else clear({ test: '', ...(id === 'a' && CLEARED_WITH.test) })
    },
  }
}
