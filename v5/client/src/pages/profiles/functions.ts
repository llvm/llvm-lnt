/**
 * The functions of a profile, as a side's function selector offers them (PF4): how hot each is for
 * the selected counter, and which one a side shows when its profile changes.
 */

import type { Schemas } from '../../api/client'
import { sortRows } from '../../components/table-sort'
import type { Counters } from './counters'

export type ProfileFunction = Schemas['ProfileFunction']

/** What `hottestFirst` and `functionShare` read of a function. */
interface Counted {
  name: string
  counters: Counters
}

/**
 * The share of the profile's top-level value of `counter` that the function `fn` accounts for, as a
 * percentage: its badge (PF4). None when the function does not have the counter, or the profile's
 * value for it is 0 or missing.
 */
export function functionShare(
  fn: Counted,
  counter: string | undefined,
  profile: Counters,
): number | undefined {
  if (counter === undefined) return undefined
  const value = fn.counters[counter]
  const total = profile[counter]
  if (value === undefined || !total) return undefined
  return (value / total) * 100
}

/**
 * `functions`, hottest first (PF4): by their value for `counter`, descending, those without it
 * after those with it, ties by name. By name alone when there is no counter.
 */
export function hottestFirst<F extends Counted>(
  functions: readonly F[],
  counter: string | undefined,
): F[] {
  const byName = sortRows(functions, (fn) => fn.name, 'ascending')
  if (counter === undefined) return byName
  return sortRows(byName, (fn) => fn.counters[counter] ?? null, 'descending')
}

/** The function a side shows: the test of its profile, and the function's name. */
export interface ShownFunction {
  test: string
  /**
   * The function's name, always resolved: when the side shows its hottest function, the name of
   * that function, never a stand-in for "the hottest".
   */
  name: string
}

/**
 * The function a side keeps or takes when the user's picks change its profile to `next`, the
 * profile of the test `next.test`, whose functions are `next.functions` (PF4):
 *
 * - its own function, `previous`, if it was showing a profile of the same test and `next` has a
 *   function of that name;
 * - otherwise the other side's function, `other`, if the other side shows a profile of the same
 *   test and `next` has a function of that name;
 * - otherwise null, and the side shows its hottest function, which the caller resolves for the
 *   counter shown.
 *
 * `previous` and `other` must be the functions the sides show, by their resolved names (see
 * `ShownFunction`), so that a side whose function is the hottest one under the current counter
 * keeps that function, rather than whichever is hottest under some later counter. This is why the
 * other side's function must be known -- its functions listed -- before this is asked.
 */
export function carriedFunction(
  next: { test: string; functions: ReadonlySet<string> },
  previous: ShownFunction | undefined,
  other: ShownFunction | undefined,
): string | null {
  for (const shown of [previous, other]) {
    if (shown?.test === next.test && next.functions.has(shown.name)) return shown.name
  }
  return null
}
