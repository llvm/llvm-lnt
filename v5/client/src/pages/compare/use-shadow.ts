/**
 * The shadow (CP8): a side B pinned, which the URL holds like a side, under `*_shadow_b`, and which
 * the chart overlays as a line. It is read like a side, by `useSide`; this adds what is particular
 * to it.
 */

import { useEffect } from 'react'
import { skipToken, useQuery } from '@tanstack/react-query'
import { commitLookupKey, commitLookupQuery } from '../../components/commit-lookup'
import { useDropUnusable } from '../../url-state'
import { NO_SHADOW, PARAMS, type Settings } from './settings'
import type { Side } from './use-side'

export interface Shadow {
  /** Whether a shadow is pinned: whether the URL names its suite, machine and commit. */
  pinned: boolean
  /** Its commit's display value (AR6), or its commit string until that is known. */
  display: string
}

/**
 * The shadow `side`, read like a side (see `useSide`), and dropped, as AR2 says of a value that
 * cannot be used (CP8), when:
 * - the URL names only part of it, as when `useSide` has dropped its suite or machine;
 * - its commit is not one of its machine's, as its picker found when side B held it;
 * - side A has no commit.
 */
export function useShadow(
  side: Side,
  sideA: Side,
  update: (changes: Partial<Settings>) => void,
): Shadow {
  const { suite, machine, commit, runs, runAgg } = side.settings
  const pinned = suite !== '' && machine !== '' && commit !== ''
  const named =
    suite !== '' ||
    machine !== '' ||
    commit !== '' ||
    runs.length > 0 ||
    runAgg !== PARAMS.run_agg_shadow_b.default
  const orphan = named && (!pinned || sideA.settings.commit === '')
  useEffect(() => {
    if (orphan) update(NO_SHADOW)
  }, [orphan, update])

  // Looked up as side B's commit picker looked it up, whose answer it shares.
  const { schema } = side
  const lookup = useQuery({
    queryKey: commitLookupKey(suite, { machine }, commit),
    queryFn:
      pinned && schema !== undefined
        ? commitLookupQuery(schema, { machine }, commit).queryFn
        : skipToken,
  })
  useDropUnusable(
    lookup,
    (found) => found !== null,
    () => update(NO_SHADOW),
  )
  return { pinned, display: lookup.data?.text ?? commit }
}
