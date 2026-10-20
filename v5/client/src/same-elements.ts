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
  const same = bothSame(kept, array)
  if (!same) setKept(array)
  return same ? kept : array
}

/** Whether `a` and `b` are both undefined, or hold the same elements. */
function bothSame(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && sameElements(a, b))
}

/**
 * `arrays`, each of them the one it was before if that holds the same elements, as
 * `useSameElements` keeps one array, and the list of them the one it was before if none changed.
 */
export function useSameElementsEach<A extends readonly unknown[] | undefined>(
  arrays: readonly A[],
): readonly A[] {
  const [kept, setKept] = useState(arrays)
  const each = arrays.map((array, i) => (bothSame(kept[i], array) ? kept[i] : array))
  const same = sameElements(kept, each)
  if (!same) setKept(each)
  return same ? kept : each
}
