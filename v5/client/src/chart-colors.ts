/**
 * The colours the charts tell their traces apart by: the Dashboard's machines (DA2), the Graph
 * page's tests (GR1). Each has a contrast of at least 3:1 against the page's background, as a
 * graphic needs to be told apart from it, and the first ones are the most distinct from each other.
 */
export const TRACE_COLORS = [
  '#1f77b4',
  '#c2410c',
  '#2ca02c',
  '#7c3aed',
  '#be185d',
  '#0e7490',
  '#a16207',
  '#4d7c0f',
  '#57534e',
  '#a21caf',
] as const

/** The colour of the `index`th trace, starting over once every colour is taken. */
export function traceColor(index: number): string {
  return TRACE_COLORS[index % TRACE_COLORS.length]
}

/**
 * The colour of whatever is called `name`, derived from the name alone, so that it has the same
 * colour wherever it is drawn, and on every visit (GR1): a 32-bit FNV-1a hash of its UTF-16 code
 * units picks one of `TRACE_COLORS`.
 */
export function colorOfName(name: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return traceColor((hash >>> 0) % TRACE_COLORS.length)
}
