/**
 * The counters of the profiles a page shows: which ones the Counter dropdown offers and starts on
 * (PF4), and how two profiles' values compare (PF3).
 */

import { compareStrings } from '../../format'

/** A profile's top-level counters, by name (E7). */
export type Counters = Readonly<Record<string, number>>

/** Every counter of `profiles`, each once, sorted by name: what the Counter dropdown offers. */
export function offeredCounters(profiles: readonly Counters[]): string[] {
  const names = new Set(profiles.flatMap((counters) => Object.keys(counters)))
  return [...names].sort(compareStrings)
}

/**
 * The counter the Counter dropdown starts on (PF4): the first offered that every one of `profiles`
 * has, or the first offered when they have none in common, or none when they have no counters.
 */
export function defaultCounter(profiles: readonly Counters[]): string | undefined {
  const offered = offeredCounters(profiles)
  return offered.find((name) => profiles.every((counters) => name in counters)) ?? offered[0]
}

/**
 * The counter shown, `selected`, unless none of `profiles` has it, in which case the dropdown goes
 * back to its default (PF4). Only meaningful once every profile shown has loaded, since a counter
 * is only found unusable from complete data (AR2 "State").
 */
export function shownCounter(
  selected: string | undefined,
  profiles: readonly Counters[],
): string | undefined {
  if (selected !== undefined && profiles.some((counters) => selected in counters)) return selected
  return defaultCounter(profiles)
}

/**
 * How `b` differs from `a`, as a percentage of `a` (PF3): `(b - a) / a * 100`. None when either is
 * missing, or when `a` is 0.
 */
export function difference(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined || b === undefined || a === 0) return undefined
  return ((b - a) / a) * 100
}
