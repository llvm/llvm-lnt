import { describe, expect, it } from 'vitest'
import { markerOf, positionsInView, traceMode } from './chart-markers'

describe('markerOf', () => {
  it('gives each trace its own marker, starting over once all are taken', () => {
    expect(markerOf(0).symbol).toBe('circle')
    expect(markerOf(1)).toEqual({ symbol: 'triangle-up', char: '▲' })
    expect(markerOf(8)).toBe(markerOf(0))
  })
})

describe('when points have markers', () => {
  it('draws a line alone without markers, but keeps the marker of a single point', () => {
    expect(traceMode(2, true)).toBe('lines+markers')
    expect(traceMode(2, false)).toBe('lines')
    expect(traceMode(1, false)).toBe('lines+markers')
  })

  it('counts the positions of the x-axis between the edges of the plot', () => {
    // Position i at 100 + 10 * i pixels, in a plot from 100 to 300 pixels.
    const geometry = {
      area: { left: 100, top: 0, width: 200, height: 100 },
      x: (value: number) => 100 + 10 * value,
      y: (value: number) => value,
      yAxes: new Map(),
    }
    expect(positionsInView(geometry, 50)).toBe(21)
    // Fewer positions than room for them.
    expect(positionsInView(geometry, 5)).toBe(5)
    // Zoomed in between positions 4.5 and 6.5, then panned past the last position.
    expect(positionsInView({ ...geometry, x: (value) => 100 + 100 * (value - 4.5) }, 50)).toBe(2)
    expect(positionsInView({ ...geometry, x: (value) => 100 + 10 * (value - 48) }, 50)).toBe(2)
  })

  it('counts them right far from the first position, though Plotly rounds pixels', () => {
    // Positions 325.95 to 526.25 of 600 in view, in a plot 1014 pixels wide, each position placed
    // to a hundredth of a pixel, as Plotly does: 326 to 526 are in view.
    const [from, to] = [325.9483905287492, 526.2466917324643]
    const pixels = 1014 / (to - from)
    const geometry = {
      area: { left: 70, top: 0, width: 1014, height: 100 },
      x: (value: number) => 70 + Math.round(pixels * (value - from) * 100) / 100,
      y: (value: number) => value,
      yAxes: new Map(),
    }
    expect(positionsInView(geometry, 600)).toBe(201)
  })

  it('counts a position a fraction of a pixel beyond an edge, where rounding may put it', () => {
    // Positions 0 to 200 across a plot from 70 to 1070 pixels, each placed to a hundredth of a
    // pixel: the last lands at 1070.01.
    const geometry = {
      area: { left: 70, top: 0, width: 1000, height: 100 },
      x: (value: number) => 70 + Math.round(value * 500.005) / 100,
      y: (value: number) => value,
      yAxes: new Map(),
    }
    expect(geometry.x(200)).toBeGreaterThan(1070)
    expect(positionsInView(geometry, 201)).toBe(201)
  })
})
