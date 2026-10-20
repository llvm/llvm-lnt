/**
 * The marker shapes the charts tell their traces apart by, beside their colours: the Graph page's
 * machines (GR1), the Compare page's shadows (CP8).
 */

/** Each marker: Plotly's symbol, and the character showing it on a chip. */
const MARKERS = [
  { symbol: 'circle', char: '●' },
  { symbol: 'triangle-up', char: '▲' },
  { symbol: 'square', char: '■' },
  { symbol: 'diamond', char: '◆' },
  { symbol: 'cross', char: '✚' },
  { symbol: 'x', char: '✖' },
  { symbol: 'star', char: '★' },
  { symbol: 'pentagon', char: '⬟' },
] as const

/** The marker of the `index`th trace, starting over once every marker is taken. */
export function markerOf(index: number): (typeof MARKERS)[number] {
  return MARKERS[index % MARKERS.length]
}
