/**
 * The links of the Compare page's Profile column (CP2): the Profiles page of each test that has a
 * profile in either side's selected runs, pre-populated as PF1 describes.
 */

import { useCallback, useMemo } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
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

/** What a list of profiles that could not be fetched failed with, and how to fetch it again. */
interface Failure {
  error: Error
  retry(): void
}

export interface ProfileLinks {
  /** The Profiles page of each test that has a profile on either side, by test. */
  links: ReadonlyMap<string, string>
  /** Why some profiles could not be listed, if any could not, and how to try again. */
  failure: Failure | null
}

/**
 * The selected runs of `side` that have profiles, in the order they were submitted, once known.
 * Which runs have profiles is asked with the URL's values as they are (CP6), but a failure is only
 * reported once the side's runs are listed, which says that those values exist.
 */
function useProfiledRuns(side: Side): { refs: RunRef[] | undefined; failure: Failure | null } {
  const { suite, machine, commit } = side.settings
  const { selected, runs } = side
  const listed = selected !== undefined
  const profiled = useQuery({
    ...commitRunsQuery(suite, machine, commit, { profiled: true }),
    enabled: suite !== '' && machine !== '' && commit !== '',
  })
  const { data } = profiled
  const refs = useMemo(() => {
    if (selected === undefined || runs.data === undefined || data === undefined) return undefined
    const withProfiles = new Set(data.map((run) => run.uuid))
    return runs.data
      .filter((run) => selected.has(run.uuid) && withProfiles.has(run.uuid))
      .map((run) => ({ suite, uuid: run.uuid }))
  }, [selected, runs.data, data, suite])
  const failure =
    listed && profiled.isError
      ? { error: profiled.error, retry: () => void profiled.refetch() }
      : null
  return { refs, failure }
}

/**
 * The run holding the profile of each test among `refs`, a side's runs, once every one's profiles
 * are listed: the latest of them that has one (PF1).
 */
function profiledBy(
  refs: readonly RunRef[] | undefined,
  profilesOf: (ref: RunRef) => RunProfile[] | undefined,
): Map<string, RunRef> | undefined {
  if (refs === undefined) return undefined
  const runOf = new Map<string, RunRef>()
  for (const ref of refs) {
    const profiles = profilesOf(ref)
    if (profiles === undefined) return undefined
    for (const { test } of profiles) runOf.set(test, ref)
  }
  return runOf
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
  const combine = useCallback(
    (results: { data?: RunProfile[]; error: Error | null; refetch: () => unknown }[]) => {
      const listed = new Map(results.map(({ data }, i) => [runRefKey(refs[i]), data]))
      const profilesOf = (ref: RunRef) => listed.get(runRefKey(ref))
      const ofA = profiledBy(refsA, profilesOf)
      const ofB = profiledBy(refsB, profilesOf)
      const links = new Map<string, string>()
      for (const test of new Set([...(ofA?.keys() ?? []), ...(ofB?.keys() ?? [])])) {
        // Side A of the Profiles page shows whichever side has a profile, when only one does.
        const [first, second] = [ofA?.get(test), ofB?.get(test)].filter((ref) => ref !== undefined)
        links.set(test, profilesPath(profileOf(first, test), second && profileOf(second, test)))
      }
      const failures = results
        .filter((result) => result.error !== null)
        .map((result) => ({ error: result.error!, retry: () => void result.refetch() }))
      return { links, failures }
    },
    [refs, refsA, refsB],
  )
  const { links, failures } = useQueries({
    queries: refs.map((ref) => runProfilesQuery(ref.suite, ref.uuid)),
    combine,
  })

  const failed = [sideA.failure, sideB.failure, ...failures].filter((entry) => entry !== null)
  const failure =
    failed.length === 0
      ? null
      : { error: failed[0].error, retry: () => failed.forEach((entry) => entry.retry()) }
  return { links, failure }
}
