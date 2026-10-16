/**
 * The function each side of the Profiles page shows (PF4), and its instructions (PF5).
 */

import { useCallback, useEffect, useMemo } from 'react'
import { useQuery, type UseQueryResult } from '@tanstack/react-query'
import type { Schemas } from '../../api/client'
import { disassemblyQuery, profileFunctionsQuery } from '../../api/profiles'
import {
  followerChoice,
  functionChoice,
  hottestFirst,
  type FunctionPick,
  type ProfileFunction,
} from './functions'
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
   * when the profile lists no functions, or side B follows a function its profile does not have,
   * and undefined until then.
   */
  name: string | null | undefined
  /** Whether side B shows that function, or none, because it follows side A's. */
  followed: boolean
  /** The instructions of that function. */
  disassembly: UseQueryResult<Schemas['FunctionDisassembly']>
  pick(name: string): void
  /** Clear the side's own function: side B only, as side A's cannot be cleared. */
  clear: (() => void) | undefined
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
 * Side A's function, as side B follows it (PF4): null when A shows none, also when its profile or
 * functions could not be loaded, and undefined while it is not known yet. While A's picks change
 * its profile to another of the same test, B keeps following the function A showed until A's new
 * one is known. A carry without a function says nothing: A may not have known its function yet.
 */
function followedFunction(
  a: ProfileSide,
  list: FunctionList,
  choice: FunctionPick | undefined,
): string | null | undefined {
  if (choice !== undefined) return choice.name
  const { kind } = a.status
  if (kind === 'none' || kind === 'failed' || list.functions.isError) return null
  if (a.carry?.name != null && a.carry.test === a.test) return a.carry.name
  return undefined
}

/** Side A's function: the one it holds, or the one `functionChoice` resolves. */
function choiceOfA(a: ProfileSide, list: FunctionList): FunctionPick | undefined {
  if (a.status.kind !== 'shown') return undefined
  if (a.heldFunction !== undefined) return { name: a.heldFunction }
  if (list.functions.data === undefined) return undefined
  return functionChoice({
    test: a.test,
    functions: list.functions.data,
    hottest: list.hottest,
    carry: a.carry,
    url: a.settings.function,
  })
}

/**
 * The function of each side, `a` and `b`, under the counter shown, `counter`. `update` changes the
 * URL.
 *
 * The page resolves side A's function once side A shows its profile and the profile's functions
 * are listed. Then it holds the function by its name (see `ProfileSide.heldFunction`), so that a
 * counter change never changes it (PF4). The URL leaves side A's function out while it is A's
 * hottest under the counter shown, and the page writes the URL again whenever that changes. Side B
 * holds nothing: its function is its own exactly when the URL names it, and otherwise side A's, or
 * none (see `followerChoice`).
 */
export function useFunctions(
  a: ProfileSide,
  b: ProfileSide,
  counter: Counter,
  update: (changes: Partial<Settings>) => void,
): { a: SideFunctions; b: SideFunctions } {
  const listA = useFunctionList(a, counter)
  const listB = useFunctionList(b, counter)
  const choiceA = choiceOfA(a, listA)
  const functionsB = listB.functions.data
  const choiceB =
    b.status.kind === 'shown' && functionsB !== undefined
      ? followerChoice(functionsB, b.settings.function, followedFunction(a, listA, choiceA))
      : undefined
  return {
    a: useSideFunction(a, listA, choiceA, update),
    b: useSideFunction(b, listB, choiceB, update),
  }
}

/**
 * The function of `side`, `choice`, its instructions, and the means to change it. Side B holds
 * nothing, and the user's picks are its own: written to the URL as they are, and cleared from it.
 */
function useSideFunction(
  side: ProfileSide,
  list: FunctionList,
  choice: FunctionPick | undefined,
  update: (changes: Partial<Settings>) => void,
): SideFunctions {
  const { id, status, carry, settings, settleFunction } = side
  const { hottest } = list
  const profile = status.kind === 'shown' ? status.uuid : undefined
  const follower = id === 'b'

  // Once side A's function is known, hold it, and drop the carry it came from.
  if (!follower && choice !== undefined && profile !== undefined) {
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

  // Side B's URL names its own function, and nothing else. Side A's leaves its function out while
  // it is the hottest, once the counter is settled, since only then does the hottest function stop
  // changing on its own.
  let written: string | undefined
  if (choice !== undefined && follower) written = (!choice.followed && choice.name) || ''
  else if (choice !== undefined && hottest !== undefined) written = urlValue(choice.name, hottest)
  // Written again for each new profile too: a pick that changes the profile removes the function
  // from the URL, and a profile already loaded can show the same function at once, leaving
  // `written` as it was.
  useEffect(() => {
    if (written !== undefined) update(sideChanges(id, { function: written }))
  }, [id, profile, written, update])

  const pick = useCallback(
    (picked: string) => {
      if (profile === undefined) return
      if (follower) {
        // Side B's pick is its own, even when it is side A's.
        update(sideChanges(id, { function: picked }))
        return
      }
      settleFunction({ profile, name: picked })
      update(sideChanges(id, { function: urlValue(picked, hottest) }))
    },
    [id, profile, hottest, follower, settleFunction, update],
  )
  // Clearing side B's own function makes it follow side A's again.
  const clear = useCallback(() => update(sideChanges(id, { function: '' })), [id, update])
  return {
    functions: list.functions,
    ordered: list.ordered,
    name: choice?.name,
    followed: choice?.followed === true,
    disassembly,
    pick,
    clear: follower ? clear : undefined,
  }
}
