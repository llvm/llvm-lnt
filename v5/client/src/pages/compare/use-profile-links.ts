/**
 * The links of the Compare page's Profile column (CP2): the Profiles page of each test that has a
 * profile in either side's selected runs, pre-populated as PF1 describes.
 */

import { useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { failuresOf, type Failures } from '../../api/failures'
import {
  commitRunsQuery,
  runProfilesQuery,
  runRefKey,
  uniqueRuns,
  type RunRef,
} from '../../api/runs'
import { profilesPath } from '../../paths'
import type { Side } from './use-side'

type RunProfile = Schemas['RunProfile']

export interface ProfileLinks {
  /** The Profiles page of each test that has a profile on either side, by test. */
  links: ReadonlyMap<string, string>
  /** Why some profiles could not be listed, if any could not: their links are missing. */
  failure: Failures
}

/** A query that has not failed, standing in for one whose failure is not to be reported. */
const UNREPORTED = { error: null, refetch: () => {} }

/**
 * The selected runs of `side` that have profiles, in the order they were submitted, once known,
 * and the query listing those with profiles. That query is sent with the URL's values as they are
 * (CP6), but its failure is only reported once the side's runs are listed, which says that those
 * values exist.
 */
function useProfiledRuns(side: Side) {
  const { suite, machine, commit } = side.settings
  const { selected, named } = side
  const query = useQuery({
    ...commitRunsQuery(suite, machine, commit, { has_profiles: true }),
    enabled: named,
  })
  const { data } = query
  const refs = useMemo(
    () =>
      selected === undefined || data === undefined
        ? undefined
        : data.filter((run) => selected.has(run.uuid)).map((run) => ({ suite, uuid: run.uuid })),
    [selected, data, suite],
  )
  return { refs, query: selected === undefined ? UNREPORTED : query }
}

/**
 * The run holding the profile of each test among `refs`, a side's runs, once every one's profiles
 * are among those `listed`, by `runRefKey`: the latest of them that has one (PF1).
 */
function profiledBy(
  refs: readonly RunRef[] | undefined,
  listed: ReadonlyMap<string, RunProfile[] | undefined>,
): Map<string, RunRef> | undefined {
  if (refs === undefined) return undefined
  const runOf = new Map<string, RunRef>()
  for (const ref of refs) {
    const profiles = listed.get(runRefKey(ref))
    if (profiles === undefined) return undefined
    for (const { test } of profiles) runOf.set(test, ref)
  }
  return runOf
}

/**
 * The profiles of each run, as plain data, which keeps its identity for as long as it holds the
 * same (see `replaceEqualDeep`), so that the links are not computed again whenever a query's state
 * changes, but only when a run's profiles arrive or the runs change.
 */
function combineProfiles(
  results: { data?: RunProfile[]; error: Error | null; refetch: () => unknown }[],
) {
  return { profiles: results.map((result) => result.data), failures: failuresOf(results) }
}

/** A side of the Profiles page: the profile of `test` in the run `ref`. */
const profileOf = ({ suite, uuid }: RunRef, test: string) => ({ suite, run: uuid, test })

/**
 * The Profile column's links, from the profiles of both sides' selected runs (CP6). A side whose
 * profiles are not all listed has no links, so that none leads to the profile of an older run.
 */
export function useProfileLinks(a: Side, b: Side): ProfileLinks {
  const sideA = useProfiledRuns(a)
  const sideB = useProfiledRuns(b)
  const { refs: refsA } = sideA
  const { refs: refsB } = sideB
  const refs = useMemo(() => uniqueRuns(refsA ?? [], refsB ?? []), [refsA, refsB])
  const { profiles, failures } = useQueries({
    queries: refs.map((ref) => runProfilesQuery(ref.suite, ref.uuid)),
    combine: combineProfiles,
  })
  const links = useMemo(() => {
    const listed = new Map(refs.map((ref, i) => [runRefKey(ref), profiles[i]]))
    const ofA = profiledBy(refsA, listed)
    const ofB = profiledBy(refsB, listed)
    const result = new Map<string, string>()
    for (const test of new Set([...(ofA?.keys() ?? []), ...(ofB?.keys() ?? [])])) {
      // Side A of the Profiles page shows whichever side has a profile, when only one does.
      const [first, second] = [ofA?.get(test), ofB?.get(test)].filter((ref) => ref !== undefined)
      result.set(test, profilesPath(profileOf(first, test), second && profileOf(second, test)))
    }
    return result
  }, [refs, profiles, refsA, refsB])

  const failure = failuresOf([
    sideA.query,
    sideB.query,
    { error: failures.error, refetch: failures.retry },
  ])
  return { links, failure }
}
