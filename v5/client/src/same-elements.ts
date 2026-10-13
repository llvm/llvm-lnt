import { useState } from 'react'

/**
 * `array`, or the one it was before if that holds the same elements, so that what is computed from
 * it is not computed again when only its identity changes: a list the URL gives, which is a new
 * array whenever any setting changes, or one filtered anew from data that did not change.
 */
export function useSameElements<A extends readonly unknown[] | undefined>(array: A): A {
  const [kept, setKept] = useState(array)
  const same =
    kept === array ||
    (kept !== undefined &&
      array !== undefined &&
      kept.length === array.length &&
      kept.every((item, i) => item === array[i]))
  if (!same) setKept(array)
  return same ? kept : array
}
