/** Whether `a` and `b` hold the same elements, in the same order. */
export function sameElements(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((item, i) => Object.is(item, b[i]))
}
