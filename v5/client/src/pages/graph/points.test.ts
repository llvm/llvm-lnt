import { describe, expect, it } from 'vitest'
import { pointsOf, type Measurement } from './points'

const POSITIONS = new Map([
  ['c1', 0],
  ['c2', 1],
  ['c3', 2],
])

const m = (commit: string, run: string, value: number): Measurement => ({ commit, run, value })

describe('pointsOf (GR1)', () => {
  it("combines each run's samples, then the runs at each commit", () => {
    const measurements = [
      // Run r1 at c1: median 2, mean 3. Run r2: 10.
      m('c1', 'r1', 1),
      m('c1', 'r1', 2),
      m('c1', 'r1', 6),
      m('c1', 'r2', 10),
    ]

    expect(pointsOf(measurements, POSITIONS, 'median', 'min')).toEqual([
      { commit: 'c1', position: 0, value: 2, runs: 2 },
    ])
    expect(pointsOf(measurements, POSITIONS, 'mean', 'max')).toEqual([
      { commit: 'c1', position: 0, value: 10, runs: 2 },
    ])
    expect(pointsOf(measurements, POSITIONS, 'mean', 'median')[0].value).toBe(6.5)
  })

  it('orders the points along the x-axis, whatever order the measurements came in', () => {
    const points = pointsOf([m('c3', 'a', 3), m('c1', 'b', 1)], POSITIONS, 'median', 'median')
    expect(points.map((point) => point.commit)).toEqual(['c1', 'c3'])
  })

  it('leaves out the commits that are not on the x-axis (GR3)', () => {
    const measurements = [m('c2', 'a', 2), m('unordered', 'b', 1)]
    const points = pointsOf(measurements, POSITIONS, 'median', 'median')
    expect(points.map((point) => point.commit)).toEqual(['c2'])
  })
})
