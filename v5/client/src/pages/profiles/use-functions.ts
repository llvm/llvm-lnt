/**
 * The function each side of the Profiles page shows (PF4), and its instructions (PF5).
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { disassemblyQuery, profileFunctionsQuery } from '../../api/profiles'
import { functionChoice, hottestFirst, type ProfileFunction, type ShownFunction } from './functions'
import { sideChanges, urlValue, type Settings } from './settings'
import type { Counter } from './use-counter'
import type { ProfileSide } from './use-side'

export interface SideFunctions {
  /** The functions of the profile that the side names, once the run's profiles are listed. */
  functions: UseQueryResult<ProfileFunction[]>
  /** Those functions, hottest first under the counter shown (PF4). */
  ordered: ProfileFunction[] | undefined
  /**
   * The function the side shows, once its profile is shown and its function is known. It is null
   * when the profile lists no functions, and undefined until then.
   */
  name: string | null | undefined
  /** The instructions of that function. */
  disassembly: UseQueryResult<Schemas['FunctionDisassembly']>
  pick(name: string): void
}

/** A side's functions, hottest first, and the hottest one, once the counter is settled. */
interface FunctionList {
  functions: UseQueryResult<ProfileFunction[]>
  ordered: ProfileFunction[] | undefined
  hottest: string | null | undefined
}

/**
 * The functions of the profile that `side` names, sorted under the counter shown. The page fetches
 * them as soon as it knows the profile's UUID, before it knows that the run belongs to the side
 * (PF8).
 */
function useFunctionList(side: ProfileSide, counter: Counter): FunctionList {
  const functions = useQuery({
    ...profileFunctionsQuery(side.settings.suite, side.uuid ?? ''),
    enabled: side.uuid !== undefined,
  })
  const ordered = useMemo(
    () => functions.data && hottestFirst(functions.data, counter.shown),
    [functions.data, counter.shown],
  )
  const hottest = ordered && counter.settled ? (ordered[0]?.name ?? null) : undefined
  return { functions, ordered, hottest }
}

/**
 * The function that `other` offers to a side that shows a profile of `test` (see `functionChoice`):
 * the function `other` shows, or showed when the user's picks began changing its profile. It is
 * undefined while that is not known yet, and null when `other` has nothing to offer.
 */
function otherShown(
  other: ProfileSide,
  list: FunctionList,
  test: string,
): ShownFunction | null | undefined {
  // Only a side that shows, or is about to show, a profile of the same test has a function for us.
  if (other.settings.test !== test || other.status.kind === 'none') return null
  // A side whose profile is changing does not wait for this one, so this one need not wait for it.
  if (other.carry !== null) return other.carry
  if (other.heldFunction !== undefined) return { test, name: other.heldFunction }
  if (other.status.kind === 'failed' || list.functions.isError) return null
  return undefined
}

/** `side`'s function: the one it holds, or the one `functionChoice` resolves. */
function choiceOf(
  side: ProfileSide,
  list: FunctionList,
  other: ProfileSide,
  otherList: FunctionList,
): { name: string | null } | undefined {
  if (side.status.kind !== 'shown') return undefined
  if (side.heldFunction !== undefined) return { name: side.heldFunction }
  if (list.functions.data === undefined) return undefined
  return functionChoice({
    test: side.settings.test,
    functions: list.functions.data,
    hottest: list.hottest,
    carry: side.carry,
    url: side.settings.function,
    other: otherShown(other, otherList, side.settings.test),
  })
}

/**
 * The function of each side, `a` and `b`, under the counter shown, `counter`. `update` changes the
 * URL.
 *
 * The page resolves a side's function once the side shows its profile and the profile's functions
 * are listed. Then it holds the function by its name (see `ProfileSide.heldFunction`), so that a
 * counter change never changes it (PF4). The URL leaves the function out while it is the side's
 * hottest under the counter shown. The page writes the URL again whenever that changes.
 */
export function useFunctions(
  a: ProfileSide,
  b: ProfileSide,
  counter: Counter,
  update: (changes: Partial<Settings>) => void,
): { a: SideFunctions; b: SideFunctions } {
  const listA = useFunctionList(a, counter)
  const listB = useFunctionList(b, counter)
  return {
    a: useSideFunction(a, listA, choiceOf(a, listA, b, listB), update),
    b: useSideFunction(b, listB, choiceOf(b, listB, a, listA), update),
  }
}

function useSideFunction(
  side: ProfileSide,
  list: FunctionList,
  choice: { name: string | null } | undefined,
  update: (changes: Partial<Settings>) => void,
): SideFunctions {
  const { id, status, carry, settings, settleFunction } = side
  const { hottest } = list
  const profile = status.kind === 'shown' ? status.uuid : undefined

  // Once the function is known, hold it, and drop the carry it came from.
  if (choice !== undefined && profile !== undefined) {
    if (side.heldFunction === undefined || carry !== null) {
      settleFunction({ profile, name: choice.name })
    }
  }

  // The instructions of the function shown. Until that function is known, fetch those of the
  // function that the URL names, at once, as the URL calls for them (PF8).
  const name = choice !== undefined ? choice.name : (carry === null && settings.function) || null
  const disassembly = useQuery({
    ...disassemblyQuery(settings.suite, side.uuid ?? '', name ?? ''),
    enabled: side.uuid !== undefined && name !== null,
  })

  // Leave the function out of the URL while it is the hottest. Wait until the counter is settled,
  // since only then does the hottest function stop changing on its own.
  const written =
    choice !== undefined && hottest !== undefined ? urlValue(choice.name, hottest) : undefined
  useEffect(() => {
    if (written !== undefined) update(sideChanges(id, { function: written }))
  }, [id, written, update])

  const pick = useCallback(
    (picked: string) => {
      if (profile === undefined) return
      settleFunction({ profile, name: picked })
      update(sideChanges(id, { function: urlValue(picked, hottest) }))
    },
    [id, profile, hottest, settleFunction, update],
  )
  return { functions: list.functions, ordered: list.ordered, name: choice?.name, disassembly, pick }
}
