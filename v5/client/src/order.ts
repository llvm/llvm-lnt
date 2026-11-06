/** Putting a list in another order (AR24). */

/**
 * `items` with `item` moved to the place of `target`: just before it if it came from after it, and
 * just after it otherwise (AR24).
 */
export function moveTo<T>(items: readonly T[], item: T, target: T): T[] {
  const from = items.indexOf(item)
  const to = items.indexOf(target)
  if (from < 0 || to < 0 || from === to) return [...items]
  const moved = items.filter((other) => other !== item)
  moved.splice(moved.indexOf(target) + (from < to ? 1 : 0), 0, item)
  return moved
}

/**
 * `items` in the order of their keys in `keys`, those it leaves out last, along with whether the two
 * differ: whether either holds a key the other does not.
 */
export function arrangeBy<T>(
  items: readonly T[],
  keys: readonly string[],
  keyOf: (item: T) => string,
): { items: T[]; outdated: boolean } {
  const byKey = new Map(items.map((item) => [keyOf(item), item]))
  const named = new Set(keys)
  const arranged = keys.flatMap((key) => byKey.get(key) ?? [])
  const left = items.filter((item) => !named.has(keyOf(item)))
  return { items: [...arranged, ...left], outdated: left.length > 0 || arranged.length < keys.length }
}
