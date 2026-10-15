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

/**
 * The function a side shows, or showed: the test of its profile, and the function's name, null for
 * none.
 */
export interface ShownFunction {
  test: string
  /**
   * The function's name, always resolved: when the side shows its hottest function, the name of
   * that function, never a stand-in for "the hottest", so that a side whose function is the hottest
   * under the current counter keeps that function, rather than whichever is hottest under a later
   * one.
   */
  name: string | null
}

/** The function a side shows, `name`, null for none, and the UUID of the profile it belongs to. */
export interface HeldFunction {
  profile: string
  name: string | null
}

/**
 * The function a side shows, once its profile, of the test `test`, lists `functions` (PF4), as
 * `{ name }`, a null name when the profile lists none, or undefined while it cannot be known yet:
 *
 * - While the user's picks are changing the side's profile, the function it showed before, `carry`,
 *   if it was of the same test and `functions` has it; or else the other side's function, `other`,
 *   on the same conditions. The other side is only asked once the side's own function is not to be
 *   kept: undefined while it cannot say, null when it has nothing to offer.
 * - Otherwise, the function the URL names, `url`, if the profile has it (PF9).
 * - Otherwise, the hottest function, `hottest`: undefined until the counter it depends on can be
 *   relied on.
 */
export function functionChoice({
  test,
  functions,
  hottest,
  carry,
  url,
  other,
}: {
  test: string
  functions: readonly ProfileFunction[]
  hottest: string | null | undefined
  carry: ShownFunction | null
  url: string
  other: ShownFunction | null | undefined
}): { name: string | null } | undefined {
  if (functions.length === 0) return { name: null }
  // A few lookups at most, once per profile: no need to index the functions.
  const has = (name: string | null) => name !== null && functions.some((fn) => fn.name === name)
  const keeps = (shown: ShownFunction | null) => shown?.test === test && has(shown.name)
  if (carry !== null) {
    if (keeps(carry)) return { name: carry.name }
    if (other === undefined) return undefined
    if (other !== null && keeps(other)) return { name: other.name }
  } else if (has(url)) {
    return { name: url }
  }
  return hottest === undefined ? undefined : { name: hottest }
}
