import { describe, expect, it } from 'vitest'
import { TRACE_COLORS, traceColor } from './chart-colors'

/** The relative luminance of a `#rrggbb` colour, as WCAG defines it. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

describe('TRACE_COLORS', () => {
  it('each stand out against the page by at least 3:1, as a graphic must', () => {
    // The page's background, --lnt-bg, is white.
    for (const color of TRACE_COLORS) {
      expect((1 + 0.05) / (luminance(color) + 0.05), color).toBeGreaterThanOrEqual(3)
    }
  })

  it('are all different, and taken again in order once all are used', () => {
    expect(new Set(TRACE_COLORS).size).toBe(TRACE_COLORS.length)
    expect(traceColor(TRACE_COLORS.length + 1)).toBe(TRACE_COLORS[1])
  })
})
