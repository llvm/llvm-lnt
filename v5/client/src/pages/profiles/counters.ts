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
 * A cell of the counter comparison (PF3): a value, `null` for N/A, or `undefined` for an empty
 * cell, while its side's values are not known.
 */
export type ComparedValue = number | null | undefined

/** The value of `counter` in `counters`, as the counter comparison shows it: empty until loaded. */
export function comparedValue(counters: Counters | undefined, counter: string): ComparedValue {
  if (counters === undefined) return undefined
  return counters[counter] ?? null
}

/**
 * How `b` differs from `a`, as a percentage of `a` (PF3): `(b - a) / a * 100`. Empty while either
 * is, and N/A when either is N/A or `a` is 0.
 */
export function difference(a: ComparedValue, b: ComparedValue): ComparedValue {
  if (a === undefined || b === undefined) return undefined
  if (a === null || b === null || a === 0) return null
  return ((b - a) / a) * 100
}

/**
 * Whether the Difference shown as `text` is a decrease or an increase (PF3), or neither when it is
 * shown as 0%. Taken from the text, so that it always agrees with what is shown, however the value
 * was rounded.
 */
export function differenceDirection(text: string): 'decrease' | 'increase' | undefined {
  if (text.startsWith('-')) return 'decrease'
  if (text.startsWith('+')) return 'increase'
  return undefined
}
