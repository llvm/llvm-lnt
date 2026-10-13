import { useState } from 'react'

/** Whether `a` and `b` hold the same elements, in the same order. */
export function sameElements(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
}

/**
 * `array`, or the one it was before if that holds the same elements, so that what is computed from
 * it is not computed again when only its identity changes: an array derived anew from data that
 * did not change, say.
 */
export function useSameElements<A extends readonly unknown[] | undefined>(array: A): A {
  const [kept, setKept] = useState(array)
  const same =
    kept === array || (kept !== undefined && array !== undefined && sameElements(kept, array))
  if (!same) setKept(array)
  return same ? kept : array
}
