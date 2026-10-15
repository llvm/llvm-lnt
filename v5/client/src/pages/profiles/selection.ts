/**
 * What a side of the Profiles page selects (PF2): the run, the test, and where it stands in
 * showing the profile of that test in that run.
 */

import type { Schemas } from '../../api/client'

type Run = Schemas['Run']

/**
 * What a side showed when the user's picks began changing its profile: its test and its function,
 * each `''` for none. While a side has one, its new test may be the other side's (PF2), and its new
 * function is carried over (PF4), whereas what the URL names is only checked (PF9).
 */
export interface Carry {
  test: string
  function: string
}

/**
 * The run a side selects among `runs`, its machine's runs at its commit that have profiles, in the
 * order they were measured: `run` if they hold it, and the latest of them otherwise (PF2, PF9), or
 * none when there are none.
 */
export function runChoice(runs: readonly Run[], run: string): string {
  if (runs.some((entry) => entry.uuid === run)) return run
  return runs.at(-1)?.uuid ?? ''
}

/**
 * The test a side shows once its run is known to have profiles of `tests` (PF2): `test` if the run
 * has a profile of it, or else, while the user's picks are changing the side's profile
 * (`carrying`), the other side's test `other` if the run has a profile of that one, or else none.
 * Without such picks, a test the run has no profile of is dropped (PF9).
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
 * Where a side stands in showing a profile:
 *
 * - `none`: it has no test.
 * - `pending`: it has a test, but something its profile depends on is still on its way: the runs,
 *   the run selected, the run's profiles, the check of the test against them, or the profile's
 *   metadata. So does a test whose machine may not exist, which is about to be dropped.
 * - `failed`: one of those could not be fetched.
 * - `shown`: it shows the profile `uuid`, whose metadata is `profile`.
 *
 * A side has a column of the page (PF7) unless it is `none`, so that the columns hold still while a
 * side's profile changes, and nothing that depends on the profiles shown is decided before every
 * side is `none` or `shown`.
 */
export type SideStatus =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'shown'; uuid: string; profile: ProfileMetadata }

/** What `sideStatus` needs to know of a fetch: its data, once it has some, and its error. */
interface Fetched<Data> {
  data: Data | undefined
  error: Error | null
}

/**
 * Where a side stands (see `SideStatus`), from what it has fetched, and what it is to select once
 * the runs and the run's profiles are known (see `runChoice` and `testChoice`): until it selects
 * them, the URL is about to change.
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
  /** Whether listing the runs failed, and that is to be said (see `runsListFailed`). */
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
