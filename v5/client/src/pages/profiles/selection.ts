/**
 * What a side of the Profiles page selects (PF2): the run and the test. Also, how far the side has
 * got in showing the profile of that test in that run.
 */

import type { Schemas } from '../../api/client'
import type { HeldFunction, ShownFunction } from './functions'

type Run = Schemas['Run']

/**
 * What a side showed when the user's picks began changing its profile: its test, `''` for none, and
 * its function. While a side has one, its new test may be the other side's (PF2), and its new
 * function is carried over (PF4), whereas what the URL names is only checked (PF9). It is used up
 * once the side's new function is known, or the side is left without a profile.
 */
export type Carry = ShownFunction

/**
 * What a side holds of the user's picks, besides the URL, for as long as the page is open: what it
 * carries over (see `Carry`), and the function it holds for its profile (see `HeldFunction`).
 */
export interface SidePicks {
  carry: Carry | null
  held: HeldFunction | null
}

export const NO_PICKS: SidePicks = { carry: null, held: null }

/**
 * How a side's picks change:
 *
 * - `change`: a pick changes the side's profile, which carries over what it showed, `shown`, unless
 *   it already carries something over, from a pick whose profile it has not shown yet.
 * - `clear`: the side is left without what it showed: a pick cleared it, or what it showed turned
 *   out to be unusable. Nothing is carried over, and no function is held, so that coming back to
 *   the same profile starts afresh.
 * - `settle`: the side's function is known, and held, which uses up the carry.
 */
export type SidePicksAction =
  | { type: 'change'; shown: Carry }
  | { type: 'clear' }
  | { type: 'settle'; held: HeldFunction }

export function sidePicks(state: SidePicks, action: SidePicksAction): SidePicks {
  switch (action.type) {
    case 'change':
      return state.carry === null ? { ...state, carry: action.shown } : state
    case 'clear':
      return NO_PICKS
    case 'settle':
      return { carry: null, held: action.held }
  }
}

/**
 * The run a side selects among `runs`: its machine's runs with profiles at its commit, in the order
 * they were measured. It keeps `run` if the list holds it, and otherwise selects the latest run
 * (PF2, PF9), or none if the list is empty.
 */
export function runChoice(runs: readonly Run[], run: string): string {
  if (runs.some((entry) => entry.uuid === run)) return run
  return runs.at(-1)?.uuid ?? ''
}

/**
 * The test a side shows, once it knows that its run has profiles of `tests` (PF2). It keeps `test`
 * if the run has a profile of it. Otherwise, while the user's picks are changing the side's profile
 * (`carrying`), it takes the other side's test, `other`, if the run has a profile of that one.
 * Otherwise it shows none. Without such picks, the page drops a test the run has no profile of
 * (PF9).
 */
export function testChoice(
  tests: { has(test: string): boolean },
  test: string,
  other: string,
  carrying: boolean,
): string {
  if (tests.has(test)) return test
  if (carrying && tests.has(other)) return other
  return ''
}

type ProfileMetadata = Schemas['ProfileMetadata']

/**
 * How far a side has got in showing a profile:
 *
 * - `none`: the side has no test.
 * - `pending`: the side has a test, but something its profile needs is still loading: the runs, the
 *   selected run, the run's profiles, the check of the test against them, or the profile's
 *   metadata. A side whose machine may not exist is pending too, until the page drops the machine.
 * - `failed`: one of those requests failed.
 * - `shown`: the side shows the profile `uuid`, whose metadata is `profile`.
 *
 * Every side except a `none` one has a column on the page (PF7). This way, the columns hold still
 * while a side's profile changes. Also, the page decides nothing that depends on the profiles shown
 * until every side is `none` or `shown`.
 */
export type SideStatus =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'shown'; uuid: string; profile: ProfileMetadata }

/** What `sideStatus` needs to know about a request: its data, once it has some, and its error. */
interface Fetched<Data> {
  data: Data | undefined
  error: Error | null
}

/**
 * How far a side has got (see `SideStatus`). It depends on what the side has fetched, and on the
 * run and test it is to select once the runs and the run's profiles are known (see `runChoice` and
 * `testChoice`). Until the URL holds that run and test, the side is pending.
 */
export function sideStatus({
  test,
  run,
  runPick,
  runsFailed,
  profiles,
  testPick,
  uuid,
  metadata,
}: {
  test: string
  run: string
  /** The run to select, once the runs are listed. */
  runPick: string | undefined
  /** Whether listing the runs failed, and the page should report it (see `runsListFailed`). */
  runsFailed: boolean
  /** The profiles of the run `run`. */
  profiles: Fetched<unknown>
  /** The test to show, once the run is the side's and its profiles are listed. */
  testPick: string | undefined
  /** The UUID of the run's profile of `test`. */
  uuid: string | undefined
  /** The metadata of that profile. */
  metadata: Fetched<ProfileMetadata>
}): SideStatus {
  if (test === '') return { kind: 'none' }
  if (runsFailed) return { kind: 'failed' }
  if (runPick !== run) return { kind: 'pending' }
  if (profiles.data === undefined) return { kind: profiles.error ? 'failed' : 'pending' }
  if (testPick !== test || uuid === undefined) return { kind: 'pending' }
  if (metadata.data === undefined) return { kind: metadata.error ? 'failed' : 'pending' }
  return { kind: 'shown', uuid, profile: metadata.data }
}
