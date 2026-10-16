/**
 * The functions of a profile, as a side's function selector offers them (PF4): how hot each is for
 * the selected counter, and which one a side shows when its profile changes.
 */

import type { Schemas } from '../../api/client'
import { sortRows } from '../../components/table-sort'
import { formatPercent } from '../../format'
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

/** A function's share of the profile's `counter`, as assistive technology reads it. */
export function shareText(share: number, counter: string): string {
  return `${formatPercent(share)} of ${counter}`
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
 * The function a side shows, or showed: the test of its profile, and the function's name. The name
 * is null when there is no function.
 */
export interface ShownFunction {
  test: string
  /**
   * The function's actual name. When the side shows its hottest function, this is that function's
   * name, never a placeholder that means "the hottest". So a side that shows the hottest function
   * under the current counter keeps that function when the counter changes, rather than switch to
   * whichever function is hottest under the new counter.
   */
  name: string | null
}

/** The function a side shows, `name` (null for none), and the UUID of its profile. */
export interface HeldFunction {
  profile: string
  name: string | null
}

/**
 * The function a side shows, once its profile has listed `functions`: `name` is null when the
 * profile lists none, or when side B shows none. `isDefault` says that side B shows it, or none,
 * because it takes side A's function by default rather than shows one the user picked.
 */
export interface FunctionPick {
  name: string | null
  isDefault?: true
}

/** Whether `functions` has a function named `name`. */
function hasFunction(functions: readonly ProfileFunction[], name: string | null): boolean {
  // A linear search, which takes far less than a render, even over thousands of functions.
  return name !== null && functions.some((fn) => fn.name === name)
}

/**
 * The function side A shows, once its profile of the test `test` has listed `functions` (PF4).
 * Returns undefined while the function cannot be known yet. In order of preference:
 *
 * - While the user's picks are changing the side's profile: the function the side showed before,
 *   `carry`, if it belonged to the same test and `functions` has it.
 * - Otherwise, the function that the URL names, `url`, if the profile has it (PF9).
 * - Otherwise, the hottest function, `hottest`. It is undefined until the counter it depends on is
 *   settled.
 */
export function functionChoice({
  test,
  functions,
  hottest,
  carry,
  url,
}: {
  test: string
  functions: readonly ProfileFunction[]
  hottest: string | null | undefined
  carry: ShownFunction | null
  url: string
}): FunctionPick | undefined {
  if (functions.length === 0) return { name: null }
  if (carry !== null) {
    if (carry.test === test && hasFunction(functions, carry.name)) return { name: carry.name }
  } else if (hasFunction(functions, url)) {
    return { name: url }
  }
  return hottest === undefined ? undefined : { name: hottest }
}

/**
 * The function side B shows, once its profile has listed `functions` (PF4): the one the user
 * picked, `picked`, which the URL names, if the profile has it. Otherwise, its default: side A's
 * function, `fromA`, if the profile has one of that name, and none otherwise. `fromA` is null when
 * side A shows no function, and undefined while it is not known yet.
 */
export function functionChoiceB(
  functions: readonly ProfileFunction[],
  picked: string,
  fromA: string | null | undefined,
): FunctionPick | undefined {
  if (functions.length === 0) return { name: null }
  if (picked !== '' && hasFunction(functions, picked)) return { name: picked }
  if (fromA === undefined) return undefined
  return { name: hasFunction(functions, fromA) ? fromA : null, isDefault: true }
}
